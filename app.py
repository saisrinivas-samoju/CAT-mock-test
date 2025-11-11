import os
import json
import asyncio
import logging
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from pathlib import Path
import uuid
import re
from io import BytesIO
import threading
import shutil
from collections import defaultdict
from time import time

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter, A4
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT

try:
    from ai_analysis import analyze_user_performance, is_ai_available
    AI_ANALYSIS_AVAILABLE = True
except ImportError as e:
    print(f"AI Analysis module not available: {e}")
    AI_ANALYSIS_AVAILABLE = False

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException, BackgroundTasks, Request, status
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel, Field
import pandas as pd

# Custom exceptions for non-request contexts
class DataLoadError(Exception):
    """Raised when data cannot be loaded (for use in background tasks)"""
    pass

class SessionSaveError(Exception):
    """Raised when session data cannot be saved (for use in background tasks)"""
    pass

# Configure structured logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - [%(filename)s:%(lineno)d] - %(message)s',
    handlers=[
        logging.FileHandler('app.log', encoding='utf-8'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# Rate limiting storage (in-memory, resets on restart)
_rate_limit_storage = defaultdict(list)
RATE_LIMIT_WINDOW = 60  # 1 minute window
RATE_LIMIT_MAX_REQUESTS = 100  # Max requests per window per IP

def check_rate_limit(client_ip: str) -> bool:
    """Check if client has exceeded rate limit"""
    current_time = time()
    # Clean old entries
    _rate_limit_storage[client_ip] = [
        req_time for req_time in _rate_limit_storage[client_ip]
        if current_time - req_time < RATE_LIMIT_WINDOW
    ]
    # Check limit
    if len(_rate_limit_storage[client_ip]) >= RATE_LIMIT_MAX_REQUESTS:
        return False
    # Record this request
    _rate_limit_storage[client_ip].append(current_time)
    return True

app = FastAPI(
    title="CAT Mock Test Portal",
    description="A comprehensive CAT exam mock test platform",
    version="1.0.0"
)

# Input validation and sanitization functions
def sanitize_username(username: str) -> str:
    """Sanitize username to prevent injection attacks"""
    if not username:
        raise ValueError("Username cannot be empty")
    # Remove any non-alphanumeric characters except underscore
    sanitized = re.sub(r'[^a-zA-Z0-9_]', '', username)
    if len(sanitized) < 3:
        raise ValueError("Username must be at least 3 characters")
    if len(sanitized) > 20:
        raise ValueError("Username must be at most 20 characters")
    return sanitized

def sanitize_text_input(text: str, max_length: int = 1000) -> str:
    """Sanitize text input to prevent XSS and length attacks"""
    if not text:
        return ""
    # Remove null bytes and control characters
    sanitized = re.sub(r'[\x00-\x1f\x7f]', '', text)
    # Limit length
    if len(sanitized) > max_length:
        sanitized = sanitized[:max_length]
    return sanitized.strip()

# Rate limiting middleware
class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # Skip rate limiting for static files
        if request.url.path.startswith("/static/") or request.url.path == "/favicon.ico":
            return await call_next(request)
        
        # Get client IP
        client_ip = request.client.host if request.client else "unknown"
        
        # Check rate limit
        if not check_rate_limit(client_ip):
            logger.warning(f"Rate limit exceeded for IP: {client_ip}, path: {request.url.path}")
            return JSONResponse(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                content={"detail": "Rate limit exceeded. Please try again later."}
            )
        
        response = await call_next(request)
        return response

# Error handling middleware
class ErrorHandlingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        try:
            response = await call_next(request)
            return response
        except HTTPException:
            raise  # Re-raise HTTPExceptions
        except Exception as e:
            logger.error(
                f"Unhandled exception: {type(e).__name__}: {str(e)}",
                exc_info=True,
                extra={"path": request.url.path, "method": request.method}
            )
            return JSONResponse(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                content={"detail": "An internal server error occurred. Please try again later."}
            )

# CORS configuration for cross-origin support
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify allowed origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Add error handling and rate limiting middleware
app.add_middleware(ErrorHandlingMiddleware)
app.add_middleware(RateLimitMiddleware)

@app.on_event("startup")
async def startup_event():
    """Initialize auto-save tasks for active sessions on server startup"""
    logger.info("Starting CAT Mock Test Portal")
    
    # Check file permissions first
    has_perms, error_msg = check_file_permissions()
    if not has_perms:
        logger.warning(f"File permission issue: {error_msg}")
        logger.warning("File operations may fail. Please check directory permissions.")
    else:
        logger.info("File permissions verified")
    
    # Clean up expired sessions
    cleanup_expired_sessions()
    
    # Start periodic cleanup task
    asyncio.create_task(periodic_cleanup_task())
    logger.info("Periodic cleanup task started (runs every hour)")
    
    # Restart auto-save tasks
    await restart_auto_save_tasks()

# Dependency validation
def check_dependencies():
    """Check if all required dependencies are installed"""
    missing_deps = []
    
    try:
        import pandas
    except ImportError:
        missing_deps.append("pandas")
    
    try:
        import openpyxl
    except ImportError:
        missing_deps.append("openpyxl")
    
    try:
        from reportlab.lib import colors
    except ImportError:
        missing_deps.append("reportlab")
    
    if missing_deps:
        error_msg = (
            f"\n❌ MISSING DEPENDENCIES: {', '.join(missing_deps)}\n"
            f"Please install missing dependencies:\n"
            f"  pip install {' '.join(missing_deps)}\n"
            f"  OR\n"
            f"  uv add {' '.join(missing_deps)}\n"
            f"\nWithout these dependencies, the application will fail when:\n"
            f"  - Saving test progress (requires openpyxl, pandas)\n"
            f"  - Generating PDF reports (requires reportlab)\n"
            f"  - Performing analysis (requires pandas)\n"
        )
        print(error_msg)
        raise ImportError(error_msg)

# Check dependencies at module load time
check_dependencies()

# Data directories
DATA_DIR = Path("data")
USER_DATA_DIR = Path("user_data")

def sanitize_filename(filename: str) -> str:
    """Sanitize filename to prevent path traversal and invalid characters"""
    # Remove any path components (../, ..\, etc.)
    filename = filename.replace("..", "").replace("/", "_").replace("\\", "_")
    
    # Remove or replace invalid characters for filenames
    invalid_chars = '<>:"|?*'
    for char in invalid_chars:
        filename = filename.replace(char, '_')
    
    # Remove leading/trailing dots and spaces (Windows doesn't allow these)
    filename = filename.strip('. ')
    
    # Limit length (Windows has 260 char path limit, leave room for directory)
    if len(filename) > 200:
        filename = filename[:200]
    
    # Ensure it's not empty
    if not filename:
        filename = "user"
    
    return filename

def cleanup_expired_sessions():
    """Clean up expired sessions (older than 24 hours)"""
    global active_sessions, _auto_save_tasks
    
    now = datetime.now()
    expired_sessions = []
    
    for session_id, session in active_sessions.items():
        time_started = ensure_datetime_time_started(session)
        elapsed = now - time_started
        
        # Remove sessions older than 24 hours
        if elapsed.total_seconds() > 86400:  # 24 hours
            expired_sessions.append(session_id)
    
    # Clean up expired sessions
    for session_id in expired_sessions:
        # Cancel auto-save task if exists
        if session_id in _auto_save_tasks:
            task = _auto_save_tasks[session_id]
            if not task.done():
                task.cancel()
            _auto_save_tasks.pop(session_id)
        
        del active_sessions[session_id]
    
    if expired_sessions:
        logger.info(f"Cleaned up {len(expired_sessions)} expired session(s)")
        save_active_sessions()

async def periodic_cleanup_task():
    """Periodic task to clean up expired sessions every hour"""
    while True:
        try:
            await asyncio.sleep(3600)  # Run every hour
            cleanup_expired_sessions()
        except Exception as e:
            logger.error(f"Error in periodic cleanup task: {e}", exc_info=True)

def check_file_permissions() -> tuple[bool, str]:
    """Check if we have write permissions to USER_DATA_DIR
    
    Returns:
        (has_permissions, error_message)
    """
    try:
        # Ensure directory exists
        USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
        
        # Try to create a test file
        test_file = USER_DATA_DIR / ".permissions_test"
        try:
            test_file.write_text("test")
            test_file.unlink()  # Delete test file
            return True, ""
        except (OSError, PermissionError) as e:
            return False, f"Cannot write to {USER_DATA_DIR}: {str(e)}"
    except (OSError, PermissionError) as e:
        return False, f"Cannot create directory {USER_DATA_DIR}: {str(e)}"
FRONTEND_DIR = Path("frontend")

# Create directories if they don't exist
USER_DATA_DIR.mkdir(exist_ok=True)
FRONTEND_DIR.mkdir(exist_ok=True)

# In-memory storage for active sessions (in production, use Redis)
active_sessions: Dict[str, Dict] = {}
users_db: Dict[str, Dict] = {}

# Store auto-save task references for cleanup
_auto_save_tasks: Dict[str, asyncio.Task] = {}

# Session persistence file
SESSIONS_FILE = USER_DATA_DIR / "active_sessions.json"

# Locks for file operations to prevent race conditions
_session_save_lock = threading.Lock()
_users_save_lock = threading.Lock()

# Pydantic models
class User(BaseModel):
    username: str = Field(..., min_length=3, max_length=20)
    name: str = Field(..., min_length=1, max_length=50)

class LoginRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=20, pattern="^[a-zA-Z0-9_]+$", description="Username (3-20 chars, alphanumeric + underscore)")

class TestSession(BaseModel):
    test_name: str
    section: str
    question_index: int
    answers: Dict[str, Any] = {}
    bookmarks: List[str] = []
    flags: Dict[str, str] = {}  # question_id: color
    time_started: datetime
    time_remaining: int  # in seconds
    section_times: Dict[str, int] = {}

class AnswerSubmission(BaseModel):
    session_id: str = Field(..., min_length=10, max_length=100, description="Session ID (UUID format)")
    question_id: str = Field(..., min_length=1, max_length=50, description="Question ID (e.g., VARC_1)")
    answer: str = Field(..., max_length=1000, description="User's answer")
    time_spent: int = Field(..., ge=0, le=3600, description="Time spent in seconds (0-3600)")

class BookmarkRequest(BaseModel):
    session_id: str = Field(..., min_length=10, max_length=100, description="Session ID (UUID format)")
    question_id: str = Field(..., min_length=1, max_length=50, description="Question ID")
    action: str = Field(..., pattern="^(add|remove)$", description="Action: 'add' or 'remove'")

class FlagRequest(BaseModel):
    session_id: str = Field(..., min_length=10, max_length=100, description="Session ID (UUID format)")
    question_id: str = Field(..., min_length=1, max_length=50, description="Question ID")
    color: str = Field(..., pattern="^(red|yellow|green|none)$", description="Flag color: 'red', 'yellow', 'green', or 'none'")

# Load test data
def load_test_data():
    """Load test data from JSON file
    
    Raises:
        DataLoadError: If file not found or invalid format
    """
    try:
        with open(DATA_DIR / "full_data.json", "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise DataLoadError("Test data file not found")
    except json.JSONDecodeError as e:
        raise DataLoadError(f"Invalid test data format: {str(e)}")

# Load users from file
def load_users():
    """Load users from JSON file"""
    users_file = USER_DATA_DIR / "users.json"
    if users_file.exists():
        try:
            with open(users_file, "r") as f:
                return json.load(f)
        except json.JSONDecodeError:
            return {}
    return {}

# Save users to file
def save_users():
    """Save users to JSON file with file locking to prevent race conditions"""
    with _users_save_lock:
        users_file = USER_DATA_DIR / "users.json"
        backup_file = USER_DATA_DIR / "users.json.backup"
        
        try:
            # Create backup before saving
            if users_file.exists():
                try:
                    shutil.copy2(users_file, backup_file)
                except Exception as backup_err:
                    print(f"Warning: Could not create backup: {backup_err}")
            
            # Write to temporary file first, then rename (atomic operation)
            temp_file = users_file.with_suffix('.json.tmp')
            with open(temp_file, "w") as f:
                json.dump(users_db, f, indent=2)
            
            # Atomic rename
            temp_file.replace(users_file)
        except Exception as e:
            print(f"Error saving users: {e}")
            # If save failed, try to restore from backup
            if backup_file.exists():
                print(f"Attempting to restore from backup...")
                try:
                    shutil.copy2(backup_file, users_file)
                    print(f"✓ Restored from backup")
                except Exception as restore_err:
                    print(f"✗ Could not restore from backup: {restore_err}")

# Initialize users database
users_db = load_users()

def load_active_sessions():
    """Load active sessions from JSON file with backup and recovery"""
    backup_file = USER_DATA_DIR / "active_sessions.json.backup"
    
    try:
        if SESSIONS_FILE.exists():
            try:
                with open(SESSIONS_FILE, 'r') as f:
                    data = json.load(f)
                    
                    # If successful, update backup
                    try:
                        if backup_file.exists():
                            shutil.copy2(SESSIONS_FILE, backup_file)
                        else:
                            shutil.copy2(SESSIONS_FILE, backup_file)
                    except Exception as backup_err:
                        print(f"Warning: Could not update backup: {backup_err}")
                    
                    # Convert datetime strings back to datetime objects
                    for session_id, session in data.items():
                        if 'time_started' in session:
                            time_started = session['time_started']
                            # Handle both string and datetime types
                            if isinstance(time_started, str):
                                try:
                                    session['time_started'] = datetime.fromisoformat(time_started)
                                except (ValueError, TypeError) as e:
                                    print(f"Warning: Invalid datetime format for session {session_id}: {time_started}. Error: {e}")
                                    # Use current time as fallback
                                    session['time_started'] = datetime.now()
                            elif isinstance(time_started, datetime):
                                # Already a datetime object, keep it
                                pass
                            else:
                                print(f"Warning: Unexpected type for time_started in session {session_id}: {type(time_started)}")
                                session['time_started'] = datetime.now()
                    return data
            except json.JSONDecodeError as e:
                print(f"ERROR: Corrupted active_sessions.json file detected: {e}")
                print(f"Attempting to recover from backup...")
                
                # Try to recover from backup
                if backup_file.exists():
                    try:
                        with open(backup_file, 'r') as f:
                            backup_data = json.load(f)
                        print(f"✓ Successfully recovered from backup")
                        # Restore backup to main file
                        shutil.copy2(backup_file, SESSIONS_FILE)
                        
                        # Convert datetime strings
                        for session_id, session in backup_data.items():
                            if 'time_started' in session:
                                time_started = session['time_started']
                                if isinstance(time_started, str):
                                    try:
                                        session['time_started'] = datetime.fromisoformat(time_started)
                                    except (ValueError, TypeError):
                                        session['time_started'] = datetime.now()
                        
                        return backup_data
                    except Exception as backup_error:
                        print(f"✗ Backup file also corrupted: {backup_error}")
                        print(f"⚠ Starting with empty sessions. Active sessions will be lost.")
                else:
                    print(f"⚠ No backup file available")
                    print(f"⚠ Starting with empty sessions. Active sessions will be lost.")
                
                # Create backup of corrupted file before proceeding
                corrupted_backup = USER_DATA_DIR / f"active_sessions.json.corrupted_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
                try:
                    shutil.copy2(SESSIONS_FILE, corrupted_backup)
                    print(f"Corrupted file saved as: {corrupted_backup}")
                except Exception:
                    pass
                
                return {}
    except Exception as e:
        print(f"Unexpected error loading sessions: {e}")
    return {}

def save_active_sessions():
    """Save active sessions to JSON file with file locking to prevent race conditions"""
    with _session_save_lock:
        try:
            # Create backup before saving
            backup_file = USER_DATA_DIR / "active_sessions.json.backup"
            if SESSIONS_FILE.exists():
                try:
                    shutil.copy2(SESSIONS_FILE, backup_file)
                except Exception as backup_err:
                    print(f"Warning: Could not create backup: {backup_err}")
            
            # Convert datetime objects to strings for JSON serialization
            sessions_to_save = {}
            for session_id, session in active_sessions.items():
                session_copy = session.copy()
                if 'time_started' in session_copy:
                    time_started = session_copy['time_started']
                    # Handle both string and datetime types
                    if isinstance(time_started, datetime):
                        session_copy['time_started'] = time_started.isoformat()
                    elif isinstance(time_started, str):
                        # Already a string, keep it (shouldn't happen but handle gracefully)
                        pass
                    else:
                        # Invalid type, use current time as fallback
                        print(f"Warning: Invalid time_started type for session {session_id}, using current time")
                        session_copy['time_started'] = datetime.now().isoformat()
                sessions_to_save[session_id] = session_copy
            
            # Write to temporary file first, then rename (atomic operation)
            temp_file = SESSIONS_FILE.with_suffix('.json.tmp')
            with open(temp_file, 'w') as f:
                json.dump(sessions_to_save, f, indent=2)
            
            # Atomic rename
            temp_file.replace(SESSIONS_FILE)
        except Exception as e:
            print(f"Error saving sessions: {e}")
            # If save failed, try to restore from backup
            backup_file = USER_DATA_DIR / "active_sessions.json.backup"
            if backup_file.exists():
                print(f"Attempting to restore from backup...")
                try:
                    shutil.copy2(backup_file, SESSIONS_FILE)
                    print(f"✓ Restored from backup")
                except Exception as restore_err:
                    print(f"✗ Could not restore from backup: {restore_err}")

def ensure_datetime_time_started(session: dict) -> datetime:
    """Ensure time_started is a datetime object, converting if necessary
    
    Args:
        session: Session dictionary
        
    Returns:
        datetime: The time_started as datetime object
        
    Side effects:
        Updates session['time_started'] to datetime object if it was a string
    """
    if 'time_started' not in session:
        return datetime.now()
    
    time_started = session.get('time_started')
    
    if isinstance(time_started, datetime):
        return time_started
    elif isinstance(time_started, str):
        try:
            dt = datetime.fromisoformat(time_started)
            session['time_started'] = dt  # Update session to datetime
            return dt
        except (ValueError, TypeError) as e:
            print(f"Warning: Invalid datetime format '{time_started}': {e}. Using current time.")
            dt = datetime.now()
            session['time_started'] = dt
            return dt
    else:
        print(f"Warning: Unexpected type for time_started: {type(time_started)}. Using current time.")
        dt = datetime.now()
        session['time_started'] = dt
        return dt

# Load existing sessions
active_sessions = load_active_sessions()

# Restart auto-save tasks for active (non-paused) sessions on server startup
async def restart_auto_save_tasks():
    """Restart auto-save tasks for active sessions loaded from disk"""
    active_count = 0
    for session_id, session in active_sessions.items():
        # Only restart auto-save for active (non-paused) sessions
        if not session.get("is_paused", False):
            # Check if task already exists (shouldn't happen on startup, but safe)
            if session_id not in _auto_save_tasks:
                task = asyncio.create_task(auto_save_session(session_id))
                _auto_save_tasks[session_id] = task
                active_count += 1
            else:
                # Task exists but might be done - restart if needed
                existing_task = _auto_save_tasks[session_id]
                if existing_task.done():
                    task = asyncio.create_task(auto_save_session(session_id))
                    _auto_save_tasks[session_id] = task
                    active_count += 1
    
    if active_count > 0:
        logger.info(f"Restarted auto-save tasks for {active_count} active session(s)")

# Auto-save task restart will be handled on app startup event below

# Auto-save functionality
async def auto_save_session(session_id: str):
    """Auto-save session data every 30 seconds
    
    Note: This function runs until the session is removed from active_sessions.
    The task reference is stored in _auto_save_tasks for cleanup.
    """
    max_iterations = 240  # Maximum 2 hours (240 * 30 seconds)
    iteration = 0
    
    while session_id in active_sessions and iteration < max_iterations:
        await asyncio.sleep(30)
        iteration += 1
        
        if session_id in active_sessions:
            try:
                await save_session_data(session_id)
            except (SessionSaveError, DataLoadError) as e:
                # Log error but continue auto-save loop
                print(f"Warning: Auto-save failed for session {session_id}: {e}")
                # Continue loop to retry on next interval
            except Exception as e:
                # Unexpected error - log and continue
                print(f"Unexpected error in auto-save for session {session_id}: {e}")
    
    # Clean up task reference when loop ends
    _auto_save_tasks.pop(session_id, None)
    
    if iteration >= max_iterations:
        print(f"Auto-save task for session {session_id} reached maximum iterations and stopped")

async def save_session_data(session_id: str):
    """Save session data to Excel file with complete test tracking
    
    Raises:
        SessionSaveError: If saving fails (for background tasks)
        DataLoadError: If test data cannot be loaded
    """
    if session_id not in active_sessions:
        return
    
    session = active_sessions[session_id]
    username = session.get("username")
    test_name = session.get("test_name", "")
    
    if not username or not test_name:
        return
    
    # Create Excel file for user (ensure consistent naming)
    # Sanitize username for filename to prevent path traversal and invalid characters
    safe_username = sanitize_filename(username)
    excel_file = USER_DATA_DIR / f"{safe_username}_progress.xlsx"
    
    # Load test data to get all questions
    try:
        test_data = load_test_data()
    except DataLoadError as e:
        # Re-raise as SessionSaveError for context
        raise SessionSaveError(f"Failed to load test data: {str(e)}")
    
    all_questions = []
    
    # Get all questions from the test
    test_found = False
    for test in test_data:
        if test["name"] == test_name:
            test_found = True
            # Flatten all questions with their details
            for section_name, section_data in test["data"].items():
                if not isinstance(section_data, list):
                    continue
                for question_obj in section_data:
                    # Validate qa_list exists and is not empty
                    qa_list = question_obj.get("qa_list", [])
                    if not qa_list or not isinstance(qa_list, list):
                        print(f"Warning: Invalid or missing qa_list in {section_name} section")
                        continue
                    
                    for qa in qa_list:
                        if not isinstance(qa, dict):
                            print(f"Warning: Invalid qa entry in {section_name} section")
                            continue
                        
                        # Use .get() to avoid KeyError
                        question_num = qa.get('question_num')
                        if question_num is None:
                            print(f"Warning: Missing question_num in {section_name} section")
                            continue
                        
                        if isinstance(question_num, list):
                            if not question_num:
                                continue
                            question_num = question_num[0]
                        
                        question_id = f"{section_name}_{question_num}"
                        raw_answer = qa.get("answer", "")
                        question_type = qa.get("question_type", "Unknown")
                        # Extract just the letter/number from HTML answer
                        extracted_answer = extract_answer_from_html(raw_answer, question_type)
                        all_questions.append({
                            "question_id": question_id,
                            "section": section_name,
                            "question_type": question_type,
                            "correct_answer": extracted_answer,  # Store extracted answer (e.g., "b" instead of "<p>b) text...</p>")
                            "question_num": question_num
                        })
            break
    
    # Validate that test was found and has questions
    if not test_found:
        raise SessionSaveError(f"Test '{test_name}' not found in test data")
    
    if not all_questions:
        raise SessionSaveError(f"Test '{test_name}' has no questions")
    
    # Prepare complete data for Excel (ALL questions, not just answered ones)
    data = []
    total_score = 0
    
    for q in all_questions:
        question_id = q["question_id"]
        answer_data = session["answers"].get(question_id, {})
        user_answer = answer_data.get("answer", "")
        correct_answer = q["correct_answer"]
        question_type = q["question_type"]
        
        # Calculate marks based on CAT marking scheme
        # Normalize and validate user answer
        user_answer_str = ""
        if user_answer is not None:
            # Handle both string and non-string types
            if isinstance(user_answer, str):
                user_answer_str = user_answer.strip()
            else:
                user_answer_str = str(user_answer).strip()
        
        # Only consider non-empty strings as attempts (exclude empty, None, "nan", etc.)
        marks = 0
        if user_answer_str and user_answer_str.lower() not in ["", "nan", "none", "null"]:
            # Normalize for comparison (case-insensitive, whitespace trimmed)
            normalized_user = user_answer_str.lower().strip()
            normalized_correct = str(correct_answer).strip().lower() if correct_answer else ""
            
            if normalized_user == normalized_correct:
                marks = 3  # +3 for correct answer
            else:
                if question_type == "Multiple Choice Question":
                    marks = -1  # -1 for wrong MCQ
                else:  # TITA
                    marks = 0   # 0 for wrong TITA
        else:
            marks = 0  # 0 for unattempted or invalid answer
        
        total_score += marks
        
        data.append({
            "Question_ID": question_id,
            "Section": q["section"],
            "Question_Number": q["question_num"],
            "Question_Type": question_type,
            "User_Answer": user_answer_str,  # Use normalized answer
            "Correct_Answer": correct_answer,
            "Marks_Obtained": marks,
            "Time_Spent": answer_data.get("time_spent", 0),
            "Bookmark_Status": question_id in session.get("bookmarks", []),
            "Flag_Color": session.get("flags", {}).get(question_id, "none"),
            "Attempt_Timestamp": answer_data.get("timestamp", datetime.now().isoformat()),
            "Test_Name": test_name,
            "Total_Score": total_score if question_id == all_questions[-1]["question_id"] else ""  # Only show total in last row (safe: validated above that list is not empty)
        })
    
    if data:
        df = pd.DataFrame(data)
        sheet_name = f'Attempt_{datetime.now().strftime("%Y%m%d_%H%M%S")}'
        
        try:
            # Check file permissions before writing
            has_perms, perm_error = check_file_permissions()
            if not has_perms:
                raise SessionSaveError(f"Cannot write to user_data directory: {perm_error}")
            
            # Check disk space (basic check - try to write a small test)
            try:
                test_file = USER_DATA_DIR / ".space_check"
                test_file.write_text("test")
                test_file.unlink()
            except (OSError, PermissionError) as e:
                raise SessionSaveError(f"Insufficient disk space or permissions: {str(e)}")
            
            # Create or append to existing Excel file
            if excel_file.exists():
                # Check if file is locked (another process using it)
                try:
                    # Try to open in append mode first to check if locked
                    with pd.ExcelWriter(excel_file, mode='a', if_sheet_exists='replace', engine='openpyxl') as writer:
                        df.to_excel(writer, sheet_name=sheet_name, index=False)
                except PermissionError as e:
                    raise SessionSaveError(f"Excel file is locked by another process: {str(e)}")
            else:
                # Create new file
                with pd.ExcelWriter(excel_file, engine='openpyxl') as writer:
                    df.to_excel(writer, sheet_name=sheet_name, index=False)
            
            print(f"Successfully saved Excel file for {username}")
        except Exception as e:
            print(f"Error saving Excel file for {username}: {e}")
            raise SessionSaveError(f"Failed to save progress: {str(e)}")

# API Routes

@app.get("/")
async def root():
    """Serve the main application page"""
    return FileResponse("frontend/index.html")

@app.head("/")
async def root_head():
    """Handle HEAD requests for the main page"""
    return FileResponse("frontend/index.html")

@app.get("/test_debug.html")
async def debug_page():
    """Serve debug test page"""
    return FileResponse("test_debug.html")

@app.post("/api/signup")
async def signup(user: User):
    """Register a new user"""
    try:
        # Sanitize and validate username
        sanitized_username = sanitize_username(user.username)
    except ValueError as e:
        logger.warning(f"Invalid username format: {user.username}")
        raise HTTPException(status_code=400, detail=str(e))
    
    # Sanitize name
    sanitized_name = sanitize_text_input(user.name, max_length=100)
    if not sanitized_name:
        raise HTTPException(status_code=400, detail="Name cannot be empty")
    
    username_lower = sanitized_username.lower()
    
    # Check if username already exists (case-insensitive)
    for existing_username in users_db.keys():
        if existing_username.lower() == username_lower:
            logger.info(f"Signup attempt with existing username: {sanitized_username}")
            raise HTTPException(status_code=400, detail="Username already exists")
    
    # Store user with original case
    users_db[sanitized_username] = {
        "name": sanitized_name,
        "created_at": datetime.now().isoformat(),
        "total_attempts": 0
    }
    
    logger.info(f"New user registered: {sanitized_username}")
    
    save_users()
    
    return {
        "message": "User registered successfully",
        "username": sanitized_username,
        "name": sanitized_name
    }

@app.post("/api/login")
async def login(request: LoginRequest):
    """Login user (username only)"""
    try:
        # Sanitize username
        sanitized_username = sanitize_username(request.username)
    except ValueError as e:
        logger.warning(f"Invalid username format in login: {request.username}")
        raise HTTPException(status_code=400, detail=str(e))
    
    username_lower = sanitized_username.lower()
    
    # Find user (case-insensitive)
    user_data = None
    actual_username = None
    
    for username, data in users_db.items():
        if username.lower() == username_lower:
            user_data = data
            actual_username = username
            break
    
    if not user_data:
        logger.info(f"Login attempt with non-existent username: {sanitized_username}")
        raise HTTPException(status_code=404, detail="User not found")
    
    logger.info(f"User logged in: {actual_username}")
    return {
        "message": "Login successful",
        "username": actual_username,
        "name": user_data["name"]
    }

@app.get("/api/tests")
async def get_available_tests():
    """Get list of available test papers"""
    try:
        test_data = load_test_data()
    except DataLoadError as e:
        raise HTTPException(status_code=500, detail=str(e))
    
    tests = []
    for test in test_data:
        # Count actual questions, not question groups (with validation)
        test_data_dict = test.get("data", {})
        varc_section = test_data_dict.get("VARC", []) if isinstance(test_data_dict, dict) else []
        dilr_section = test_data_dict.get("DILR", []) if isinstance(test_data_dict, dict) else []
        qa_section = test_data_dict.get("QA", []) if isinstance(test_data_dict, dict) else []
        
        varc_count = sum(len(q.get("qa_list", [])) for q in varc_section if isinstance(q, dict) and isinstance(q.get("qa_list"), list))
        dilr_count = sum(len(q.get("qa_list", [])) for q in dilr_section if isinstance(q, dict) and isinstance(q.get("qa_list"), list))
        qa_count = sum(len(q.get("qa_list", [])) for q in qa_section if isinstance(q, dict) and isinstance(q.get("qa_list"), list))
        
        tests.append({
            "name": test["name"],
            "sections": {
                "VARC": varc_count,
                "DILR": dilr_count,
                "QA": qa_count
            },
            "total_questions": varc_count + dilr_count + qa_count
        })
    
    return tests

@app.post("/api/start-test")
async def start_test(request: dict):
    """Start a new test session"""
    username = request.get("username")
    test_name = request.get("test_name")
    
    if not username or not test_name:
        raise HTTPException(status_code=400, detail="Username and test name are required")
    
    # Validate username format
    if not isinstance(username, str) or not re.match(r'^[a-zA-Z0-9_]{3,20}$', username):
        raise HTTPException(status_code=400, detail="Invalid username format")
    
    # Validate test_name is a string and not empty
    if not isinstance(test_name, str) or not test_name.strip():
        raise HTTPException(status_code=400, detail="Invalid test name")
    
    # Clean up old sessions for this user to prevent confusion
    sessions_to_remove = []
    for sid, session in active_sessions.items():
        if session.get("username") == username:
            # Keep paused sessions, remove active ones (including old sessions without is_paused field)
            if not session.get("is_paused", False):
                sessions_to_remove.append(sid)
    
    for sid in sessions_to_remove:
        # Cancel auto-save task if exists
        if sid in _auto_save_tasks:
            task = _auto_save_tasks[sid]
            if not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            _auto_save_tasks.pop(sid)
        
        del active_sessions[sid]
        print(f"Cleaned up old session {sid} for user {username}")
    
    print(f"Cleaned up {len(sessions_to_remove)} old sessions for {username}")
    
    # Generate session ID
    session_id = str(uuid.uuid4())
    
    # Create session
    active_sessions[session_id] = {
        "username": username,
        "test_name": test_name,
        "section": "VARC",  # Start with VARC
        "question_index": 0,
        "answers": {},
        "bookmarks": [],
        "flags": {},
        "time_started": datetime.now(),
        "time_remaining": 7200,  # 120 minutes in seconds
        "section_times": {
            "VARC": 2400,  # 40 minutes in seconds
            "DILR": 2400,
            "QA": 2400
        },
        "is_paused": False
    }
    
    # Save sessions to disk
    save_active_sessions()
    
    # Cancel any existing auto-save task for this session (shouldn't happen, but safe)
    if session_id in _auto_save_tasks:
        existing_task = _auto_save_tasks[session_id]
        if not existing_task.done():
            existing_task.cancel()
        _auto_save_tasks.pop(session_id)
    
    # Start auto-save task and store reference
    task = asyncio.create_task(auto_save_session(session_id))
    _auto_save_tasks[session_id] = task
    
    return {
        "session_id": session_id,
        "message": "Test session started",
        "section": "VARC",
        "time_remaining": 7200
    }

@app.get("/api/test-data/{test_name}")
async def get_test_data(test_name: str):
    """Get test data for a specific test"""
    try:
        test_data = load_test_data()
    except DataLoadError as e:
        raise HTTPException(status_code=500, detail=str(e))
    
    for test in test_data:
        if test["name"] == test_name:
            return test["data"]
    
    raise HTTPException(status_code=404, detail="Test not found")

@app.get("/api/session/{session_id}")
async def get_session(session_id: str):
    """Get current session state"""
    # Validate session_id format (UUID format)
    if not session_id or len(session_id) > 100:
        raise HTTPException(status_code=400, detail="Invalid session ID format")
    
    # Basic UUID format validation (UUIDs are 36 chars with dashes)
    if len(session_id) < 10 or len(session_id) > 100:
        raise HTTPException(status_code=400, detail="Invalid session ID length")
    
    if session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    session = active_sessions[session_id]
    
    # Calculate remaining time - ensure time_started is datetime
    time_started = ensure_datetime_time_started(session)
    elapsed = datetime.now() - time_started
    elapsed_seconds = int(elapsed.total_seconds())
    
    # Clamp time_remaining to 0 (never negative)
    current_time_remaining = session.get("time_remaining", 7200)
    remaining = max(0, current_time_remaining - elapsed_seconds)
    
    # Update session with clamped value (prevent negative in storage)
    session["time_remaining"] = remaining
    
    return {
        **session,
        "time_remaining": remaining,
        "time_started": session["time_started"].isoformat()
    }

@app.post("/api/submit-answer")
async def submit_answer(submission: AnswerSubmission):
    """Submit an answer for a question"""
    if submission.session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    session = active_sessions[submission.session_id]
    
    # Validate question_id format (should be like "VARC_1", "DILR_5", etc.)
    if not submission.question_id or not isinstance(submission.question_id, str):
        raise HTTPException(status_code=400, detail="Invalid question_id format")
    
    # Validate question_id matches expected pattern
    import re
    if not re.match(r'^(VARC|DILR|QA)_\d+$', submission.question_id):
        raise HTTPException(status_code=400, detail=f"Invalid question_id format: {submission.question_id}. Expected format: SECTION_NUMBER")
    
    # Load test data to get correct answer
    try:
        test_data = load_test_data()
    except DataLoadError as e:
        raise HTTPException(status_code=500, detail=str(e))
    
    correct_answer = ""
    section = ""
    
    # Find correct answer in test data
    for test in test_data:
        if test.get("name") == session.get("test_name"):
            test_data_dict = test.get("data", {})
            if not isinstance(test_data_dict, dict):
                break
            
            for section_name, questions in test_data_dict.items():
                if not isinstance(questions, list):
                    continue
                for question_obj in questions:
                    if not isinstance(question_obj, dict):
                        continue
                    
                    # Validate qa_list exists and is not empty
                    qa_list = question_obj.get("qa_list", [])
                    if not qa_list or not isinstance(qa_list, list):
                        continue
                    
                    for qa in qa_list:
                        if not isinstance(qa, dict):
                            continue
                        
                        # Use .get() to avoid KeyError
                        question_num = qa.get('question_num')
                        if question_num is None:
                            continue
                        
                        if isinstance(question_num, list):
                            if not question_num:
                                continue
                            question_num = question_num[0]
                        
                        q_id = f"{section_name}_{question_num}"
                        
                        if q_id == submission.question_id:
                            raw_answer = qa.get("answer", "")
                            question_type = qa.get("question_type", "")
                            # Extract just the letter/number from HTML answer
                            correct_answer = extract_answer_from_html(raw_answer, question_type)
                            section = section_name
                            break
    
    # Validate that question was found
    if not correct_answer and submission.question_id:
        # Log warning but don't fail - might be a question not in test data
        logger.warning(f"Question {submission.question_id} not found in test data for session {submission.session_id}")
    
    # Validate time_spent is non-negative and reasonable (max 1 hour per question)
    time_spent = submission.time_spent
    if time_spent < 0:
        time_spent = 0
    elif time_spent > 3600:  # Max 1 hour per question
        time_spent = 3600
        logger.warning(f"Time spent for question {submission.question_id} exceeds 1 hour, clamping to 3600s")
    
    # Sanitize answer before storing
    sanitized_answer = sanitize_text_input(submission.answer, max_length=1000)
    
    # Store answer
    session["answers"][submission.question_id] = {
        "answer": sanitized_answer,
        "correct_answer": correct_answer,
        "time_spent": time_spent,
        "timestamp": datetime.now().isoformat(),
        "section": section
    }
    
    logger.debug(f"Answer submitted: {submission.question_id} = {sanitized_answer}")
    
    # Save sessions to disk to persist answers
    save_active_sessions()
    
    return {"message": "Answer submitted successfully"}

@app.post("/api/bookmark")
async def toggle_bookmark(request: BookmarkRequest):
    """Toggle bookmark for a question"""
    if request.session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    session = active_sessions[request.session_id]
    
    if request.action == "add":
        if request.question_id not in session["bookmarks"]:
            session["bookmarks"].append(request.question_id)
    elif request.action == "remove":
        if request.question_id in session["bookmarks"]:
            session["bookmarks"].remove(request.question_id)
    
    # Save sessions to disk to persist bookmarks
    save_active_sessions()
    
    return {"message": f"Bookmark {request.action}ed successfully"}

@app.post("/api/flag")
async def set_flag(request: FlagRequest):
    """Set flag color for a question"""
    if request.session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    session = active_sessions[request.session_id]
    
    if request.color == "none":
        session["flags"].pop(request.question_id, None)
    else:
        session["flags"][request.question_id] = request.color
    
    # Save sessions to disk to persist flags
    save_active_sessions()
    
    return {"message": "Flag updated successfully"}

@app.post("/api/save-session")
async def manual_save_session(request: dict):
    """Manually save session data"""
    session_id = request.get("session_id")
    if session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    try:
        await save_session_data(session_id)
    except (SessionSaveError, DataLoadError) as e:
        raise HTTPException(status_code=500, detail=str(e))
    
    return {"message": "Session saved successfully"}

@app.post("/api/pause-test")
async def pause_test(request: dict):
    """Pause the current test"""
    session_id = request.get("session_id")
    if session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    session = active_sessions[session_id]
    
    # Save current time remaining - ensure time_started is datetime
    time_started = ensure_datetime_time_started(session)
    elapsed = datetime.now() - time_started
    elapsed_seconds = int(elapsed.total_seconds())
    
    # Clamp time_remaining to 0 (never negative in storage)
    current_time_remaining = session.get("time_remaining", 7200)
    session["time_remaining"] = max(0, current_time_remaining - elapsed_seconds)
    session["paused_at"] = datetime.now().isoformat()
    session["is_paused"] = True
    
    # Save session data to Excel and persist sessions to disk
    try:
        await save_session_data(session_id)
    except (SessionSaveError, DataLoadError) as e:
        # Log error but don't fail pause operation
        print(f"Warning: Failed to save session data during pause: {e}")
    
    save_active_sessions()
    
    return {"message": "Test paused successfully"}

@app.post("/api/cleanup-sessions")
async def cleanup_all_sessions():
    """Admin endpoint to clean up stale sessions"""
    initial_count = len(active_sessions)
    
    # Keep only paused sessions and recent active sessions (within last 24 hours)
    current_time = datetime.now()
    sessions_to_keep = {}
    
    for session_id, session in active_sessions.items():
        time_started = session.get("time_started")
        is_paused = session.get("is_paused", False)
        
        # Keep if paused or if started within last 24 hours
        if is_paused:
            sessions_to_keep[session_id] = session
        elif isinstance(time_started, datetime):
            age = (current_time - time_started).total_seconds()
            if age < 24 * 3600:  # Less than 24 hours old
                sessions_to_keep[session_id] = session
    
    # Update active sessions
    active_sessions.clear()
    active_sessions.update(sessions_to_keep)
    
    # Save cleaned sessions
    save_active_sessions()
    
    cleaned_count = initial_count - len(active_sessions)
    return {
        "message": f"Cleaned up {cleaned_count} stale sessions",
        "before": initial_count,
        "after": len(active_sessions)
    }

@app.get("/api/paused-tests/{username}")
async def get_paused_tests(username: str):
    """Get all paused tests for a user"""
    paused_tests = []
    
    for session_id, session in active_sessions.items():
        if (session.get("username") == username and 
            session.get("is_paused", False) and
            not session.get("is_completed", False) and  # Exclude completed tests
            session.get("paused_at")):
            
            # Calculate progress
            answered_questions = len(session.get("answers", {}))
            total_questions = 67  # CAT has 67 questions total
            
            paused_tests.append({
                "session_id": session_id,
                "test_name": session.get("test_name", "Unknown Test"),
                "section": session.get("section", "Unknown"),
                "question_index": session.get("question_index", 0),
                "time_remaining": session.get("time_remaining", 0),
                "paused_at": session.get("paused_at"),
                "answered_questions": answered_questions,
                "total_questions": total_questions,
                "bookmarks": len(session.get("bookmarks", [])),
                "flags": len(session.get("flags", {}))
            })
    
    return paused_tests

@app.get("/api/active-session/{username}")
async def get_active_session(username: str):
    """Get active non-paused session for a user (for page refresh recovery)"""
    for session_id, session in active_sessions.items():
        if (session.get("username") == username and 
            not session.get("is_paused", False) and
            not session.get("is_completed", False)):  # Exclude completed tests
            
            # Calculate time remaining - ensure time_started is datetime
            time_started = ensure_datetime_time_started(session)
            elapsed = datetime.now() - time_started
            elapsed_seconds = int(elapsed.total_seconds())
            
            # Clamp time_remaining to 0 (never negative)
            current_time_remaining = session.get("time_remaining", 7200)
            remaining = max(0, current_time_remaining - elapsed_seconds)
            
            # Update session with clamped value
            session["time_remaining"] = remaining
            
            return {
                "session_id": session_id,
                "test_name": session.get("test_name", "Unknown Test"),
                "section": session.get("section", "VARC"),
                "question_index": session.get("question_index", 0),
                "time_remaining": remaining,
                "answers": session.get("answers", {}),
                "bookmarks": session.get("bookmarks", []),
                "flags": session.get("flags", {}),
                "is_paused": session.get("is_paused", False)
            }
    
    raise HTTPException(status_code=404, detail="No active session found")

@app.post("/api/complete-test")
async def complete_test(request: dict):
    """Mark a test as completed and clean up the session"""
    session_id = request.get("session_id")
    if session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    session = active_sessions[session_id]
    
    # Mark session as completed
    session["is_completed"] = True
    session["completed_at"] = datetime.now().isoformat()
    
    # Stop auto-save task
    if session_id in _auto_save_tasks:
        task = _auto_save_tasks[session_id]
        if not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        _auto_save_tasks.pop(session_id)
    
    # Final save of session data before removing
    try:
        await save_session_data(session_id)
    except (SessionSaveError, DataLoadError) as e:
        print(f"Warning: Failed to save session data during completion: {e}")
    
    # Remove from active sessions (test is completed, no need to resume)
    del active_sessions[session_id]
    save_active_sessions()
    
    return {"message": "Test marked as completed successfully"}

@app.post("/api/cleanup-session")
async def cleanup_session(request: dict):
    """Clean up a specific session"""
    session_id = request.get("session_id")
    
    # Validate session_id format and length
    if not session_id or not isinstance(session_id, str):
        raise HTTPException(status_code=400, detail="Session ID is required")
    
    if len(session_id) < 10 or len(session_id) > 100:
        raise HTTPException(status_code=400, detail="Invalid session ID format")
    
    if session_id in active_sessions:
        # Cancel auto-save task if exists
        if session_id in _auto_save_tasks:
            task = _auto_save_tasks[session_id]
            if not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            _auto_save_tasks.pop(session_id)
        
        del active_sessions[session_id]
        save_active_sessions()
        return {"message": f"Session {session_id} cleaned up successfully"}
    
    return {"message": "Session not found or already cleaned"}

@app.post("/api/resume-test")
async def resume_test(request: dict):
    """Resume a paused test"""
    session_id = request.get("session_id")
    if session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    session = active_sessions[session_id]
    
    # Check if test is already completed - prevent resuming completed tests
    if session.get("is_completed", False):
        raise HTTPException(status_code=400, detail="Cannot resume a completed test. Please view results from 'Tests Completed' section.")
    
    # Validate and clamp time_remaining - ensure it's never negative
    current_time_remaining = session.get("time_remaining", 7200)
    if current_time_remaining < 0:
        print(f"Warning: Session {session_id} had negative time_remaining ({current_time_remaining}), clamping to 0")
        current_time_remaining = 0
        session["time_remaining"] = 0
    
    # Reset start time to current time (this resets the timer calculation)
    session["time_started"] = datetime.now()
    session.pop("paused_at", None)
    session["is_paused"] = False
    
    # Ensure time_remaining is valid (non-negative)
    session["time_remaining"] = max(0, current_time_remaining)
    
    # Save sessions to disk
    save_active_sessions()
    
    # Cancel existing auto-save task if exists
    if session_id in _auto_save_tasks:
        existing_task = _auto_save_tasks[session_id]
        if not existing_task.done():
            existing_task.cancel()
            try:
                await existing_task
            except asyncio.CancelledError:
                pass
        _auto_save_tasks.pop(session_id)
    
    # Restart auto-save task and store reference
    task = asyncio.create_task(auto_save_session(session_id))
    _auto_save_tasks[session_id] = task
    
    return {"message": "Test resumed successfully"}

@app.get("/api/user-stats/{username}")
async def get_user_stats(username: str):
    """Get user's progress statistics"""
    # Sanitize username for filename to prevent path traversal and invalid characters
    safe_username = sanitize_filename(username)
    excel_file = USER_DATA_DIR / f"{safe_username}_progress.xlsx"
    
    if not excel_file.exists():
        # Return default stats if no data exists
        return {
            "total_time": 0,
            "tests_completed": 0,
            "average_score": 0,
            "total_attempts": 0,
            "last_test_date": None
        }
    
    try:
        # Read Excel file and calculate statistics
        df = pd.read_excel(excel_file, sheet_name=None)  # Read all sheets
        
        total_time = 0
        test_scores = []  # Store individual test scores (actual marks)
        latest_attempts = {}  # Store latest attempt per test
        
        # First, identify latest attempt for each test
        for sheet_name, sheet_data in df.items():
            if not sheet_data.empty and 'Test_Name' in sheet_data.columns:
                test_name = sheet_data['Test_Name'].iloc[0]
                attempt_timestamp = sheet_name  # Sheet name contains timestamp
                
                if test_name not in latest_attempts or attempt_timestamp > latest_attempts[test_name]['timestamp']:
                    latest_attempts[test_name] = {
                        'timestamp': attempt_timestamp,
                        'sheet_name': sheet_name,
                        'data': sheet_data
                    }
        
        # Calculate stats only from latest attempts
        for test_name, attempt_info in latest_attempts.items():
            sheet_data = attempt_info['data']
            
            # Calculate time spent
            if 'Time_Spent' in sheet_data.columns:
                total_time += sheet_data['Time_Spent'].sum()
            
            # Calculate actual CAT score using marks
            if 'Marks_Obtained' in sheet_data.columns:
                test_score = sheet_data['Marks_Obtained'].sum()
                test_scores.append(test_score)
            elif 'Total_Score' in sheet_data.columns:
                # Fallback: get total score from the last row
                total_score_values = sheet_data['Total_Score'].dropna()
                if not total_score_values.empty:
                    test_score = total_score_values.iloc[-1]
                    test_scores.append(test_score)
        
        # Calculate average score (mean of actual marks obtained)
        average_score = sum(test_scores) / len(test_scores) if test_scores else 0
        tests_completed = len(latest_attempts)
        
        # Calculate overall totals for additional info (from latest attempts only)
        total_questions_attempted = sum(len(attempt_info['data']) for attempt_info in latest_attempts.values())
        total_correct_answers = sum(
            (attempt_info['data']['User_Answer'] == attempt_info['data']['Correct_Answer']).sum() 
            for attempt_info in latest_attempts.values() 
            if 'User_Answer' in attempt_info['data'].columns and 'Correct_Answer' in attempt_info['data'].columns
        )
        
        # Get last test date from the most recent sheet
        last_test_date = None
        if df:
            latest_sheet = max(df.keys())  # Assuming sheet names are sortable by date
            if 'Attempt_Timestamp' in df[latest_sheet].columns:
                timestamps = df[latest_sheet]['Attempt_Timestamp'].dropna()
                if not timestamps.empty:
                    last_test_date = timestamps.iloc[0]
        
        return {
            "total_time": int(total_time) if hasattr(total_time, 'item') else int(total_time),
            "tests_completed": int(tests_completed) if hasattr(tests_completed, 'item') else int(tests_completed),
            "average_score": float(round(average_score, 1)) if hasattr(average_score, 'item') else float(round(average_score, 1)),
            "total_attempts": len(df.keys()) if df else 0,  # Total attempts (including retakes)
            "unique_tests_taken": int(tests_completed) if hasattr(tests_completed, 'item') else int(tests_completed),  # Unique tests
            "last_test_date": str(last_test_date) if last_test_date else None,
            "total_questions_attempted": int(total_questions_attempted) if hasattr(total_questions_attempted, 'item') else int(total_questions_attempted),
            "total_correct_answers": int(total_correct_answers) if hasattr(total_correct_answers, 'item') else int(total_correct_answers),
            "individual_test_scores": [float(round(score, 1)) for score in test_scores],
            "max_possible_score": 198,  # 66 questions × 3 marks = 198
            "calculation_method": "CAT_marking_latest_attempts_only"
        }
        
    except Exception as e:
        print(f"Error reading user stats: {e}")
        return {
            "total_time": 0,
            "tests_completed": 0,
            "average_score": 0,
            "total_attempts": 0,
            "last_test_date": None
        }

@app.get("/api/completed-tests/{username}")
async def get_completed_tests(username: str):
    """Get all completed test results for a user"""
    # Sanitize username for filename to prevent path traversal and invalid characters
    safe_username = sanitize_filename(username)
    excel_file = USER_DATA_DIR / f"{safe_username}_progress.xlsx"
    
    if not excel_file.exists():
        return []
    
    try:
        # Read Excel file - each sheet is a completed test
        df_dict = {}
        with pd.ExcelFile(excel_file) as xl_file:
            for sheet_name in xl_file.sheet_names:
                df_dict[sheet_name] = pd.read_excel(xl_file, sheet_name=sheet_name)
        
        completed_tests = []
        
        # Get unique tests and their latest attempts
        test_attempts = {}
        for sheet_name, sheet_data in df_dict.items():
            if not sheet_data.empty and 'Test_Name' in sheet_data.columns:
                test_name = sheet_data['Test_Name'].iloc[0]
                timestamp = sheet_name  # Sheet name is the timestamp
                
                if test_name not in test_attempts or timestamp > test_attempts[test_name]['timestamp']:
                    # Calculate stats from this attempt
                    total_score = 0
                    if 'Marks_Obtained' in sheet_data.columns:
                        total_score = sheet_data['Marks_Obtained'].sum()
                    elif 'Total_Score' in sheet_data.columns:
                        total_score_values = sheet_data['Total_Score'].dropna()
                        if not total_score_values.empty:
                            total_score = total_score_values.iloc[-1]
                    
                    # Calculate accuracy
                    total_attempted = len(sheet_data[sheet_data['User_Answer'].notna()]) if 'User_Answer' in sheet_data.columns else 0
                    total_correct = (sheet_data['User_Answer'] == sheet_data['Correct_Answer']).sum() if 'User_Answer' in sheet_data.columns and 'Correct_Answer' in sheet_data.columns else 0
                    accuracy = (total_correct / total_attempted * 100) if total_attempted > 0 else 0
                    
                    test_attempts[test_name] = {
                        'timestamp': timestamp,
                        'test_name': test_name,
                        'total_score': float(total_score),
                        'accuracy': round(accuracy, 1),
                        'date': timestamp.split('_')[0] if '_' in timestamp else timestamp
                    }
        
        # Convert to list format
        completed_tests = list(test_attempts.values())
        # Sort by timestamp (most recent first)
        completed_tests.sort(key=lambda x: x['timestamp'], reverse=True)
        
        return completed_tests
        
    except Exception as e:
        print(f"Error reading completed tests: {e}")
        return []

@app.get("/api/user-progress/{username}")
async def get_user_progress(username: str):
    """Get user's test progress and download Excel file"""
    # Sanitize username for filename to prevent path traversal and invalid characters
    safe_username = sanitize_filename(username)
    excel_file = USER_DATA_DIR / f"{safe_username}_progress.xlsx"
    
    if not excel_file.exists():
        raise HTTPException(status_code=404, detail="No progress data found for user")
    
    return FileResponse(
        path=excel_file,
        filename=f"{username}_progress.xlsx",
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )

# Mount static files
app.mount("/static", StaticFiles(directory="frontend"), name="static")

# Vercel handler
def handler(request):
    return app(request)

@app.get("/api/ai-analysis/{username}")
async def get_ai_analysis(username: str):
    """Get AI-powered performance analysis for a user"""
    if not AI_ANALYSIS_AVAILABLE:
        return {
            "status": "unavailable", 
            "message": "AI analysis module not available. Please check dependencies.",
            "basic_analysis": "Enable AI features with OpenAI API key or local LLM for detailed insights."
        }
    
    # Sanitize username for filename to prevent path traversal and invalid characters
    safe_username = sanitize_filename(username)
    excel_file = USER_DATA_DIR / f"{safe_username}_progress.xlsx"
    
    if not excel_file.exists():
        raise HTTPException(status_code=404, detail="No test data found for user")
    
    try:
        # Load Excel data to get latest test performance
        df_dict = {}
        
        with pd.ExcelFile(excel_file) as xl_file:
            for sheet_name in xl_file.sheet_names:
                df_dict[sheet_name] = pd.read_excel(xl_file, sheet_name=sheet_name)
        
        if not df_dict:
            raise HTTPException(status_code=404, detail="No test data found")
        
        # Get the latest test data (most recent sheet)
        latest_sheet = max(df_dict.keys())
        latest_df = df_dict[latest_sheet]
        
        if latest_df.empty:
            raise HTTPException(status_code=404, detail="Test data is empty")
        
        # Calculate section-wise scores and marks
        section_scores = {"VARC": 0, "DILR": 0, "QA": 0}
        
        # Get dynamic question counts for max scores (3 marks per question)
        try:
            test_data = load_test_data()
        except DataLoadError as e:
            raise HTTPException(status_code=500, detail=str(e))
        
        test_name = latest_sheet.split('_')[0] if '_' in latest_sheet else "Unknown"
        
        # Find the test data for this specific test
        current_test = None
        for test in test_data:
            if test["name"] == test_name:
                current_test = test
                break
        
        if current_test:
            # Safe dictionary access with defaults
            test_data = current_test.get("data", {})
            varc_section = test_data.get("VARC", [])
            dilr_section = test_data.get("DILR", [])
            qa_section = test_data.get("QA", [])
            
            varc_count = sum(len(q.get("qa_list", [])) for q in varc_section if isinstance(q, dict))
            dilr_count = sum(len(q.get("qa_list", [])) for q in dilr_section if isinstance(q, dict))
            qa_count = sum(len(q.get("qa_list", [])) for q in qa_section if isinstance(q, dict))
            section_max_scores = {
                "VARC": varc_count * 3,
                "DILR": dilr_count * 3,
                "QA": qa_count * 3
            }
        else:
            # Fallback to default values
            section_max_scores = {"VARC": 72, "DILR": 60, "QA": 66}
        
        for _, row in latest_df.iterrows():
            section = row.get('Section', '')
            marks = row.get('Marks_Obtained', 0)
            if section in section_scores:
                section_scores[section] += marks
        
        total_score = sum(section_scores.values())
        
        # Enhanced data preparation for AI analysis
        question_records = latest_df.to_dict('records')
        
        # Calculate detailed time analysis
        time_data = calculate_detailed_time_analysis(question_records)
        
        # Calculate performance insights
        performance_insights = calculate_performance_insights(question_records, section_scores)
        
        user_performance_data = {
            "username": username,
            "test_name": latest_sheet.split('_')[0] if '_' in latest_sheet else "Unknown",
            "section_scores": section_scores,
            "total_score": total_score,
            "question_data": question_records,
            "time_analysis": time_data,
            "performance_insights": performance_insights
        }
        
        # Generate analysis
        if is_ai_available():
            test_name = user_performance_data.get("test_name", "Unknown")
            analysis_result = await analyze_user_performance(user_performance_data, test_name)
            analysis_text = analysis_result.get("analysis", "Analysis not available")
            ai_powered = True
        else:
            test_name = user_performance_data.get("test_name", "Unknown")
            try:
                analysis_text = generate_basic_analysis(section_scores, total_score, test_name)
            except DataLoadError as e:
                # Fallback to simple analysis if test data unavailable
                analysis_text = f"# Performance Analysis\n\nTotal Score: {total_score}\n\nNote: Detailed analysis unavailable due to test data loading error."
                print(f"Warning: Could not load test data for analysis: {e}")
            ai_powered = False
            
        return {
            "status": "success",
            "analysis": analysis_text,
            "performance_data": {
                "section_scores": section_scores,
                "section_max_scores": section_max_scores,
                "total_score": total_score,
                "max_possible_score": 198,
                "section_percentages": {
                    section: round((score / section_max_scores[section] * 100), 1) if section_max_scores.get(section, 0) > 0 else 0
                    for section, score in section_scores.items()
                }
            },
            "ai_powered": ai_powered
        }
        
    except Exception as e:
        print(f"Error in AI analysis for {username}: {e}")
        raise HTTPException(status_code=500, detail=f"Analysis generation failed: {str(e)}")


@app.post("/api/ai-followup")
async def ai_followup_question(request: dict):
    """Handle follow-up questions about the AI analysis"""
    username = request.get("username")
    question = request.get("question")
    
    if not username or not question:
        raise HTTPException(status_code=400, detail="Username and question are required")
    
    if not AI_ANALYSIS_AVAILABLE or not is_ai_available():
        return {
            "status": "unavailable",
            "response": "AI follow-up questions are not available. Please ensure your OpenAI API key is configured or local LLM is running."
        }
    
    try:
        # Get user's latest test data for context
        # Sanitize username for filename to prevent path traversal and invalid characters
        safe_username = sanitize_filename(username)
        excel_file = USER_DATA_DIR / f"{safe_username}_progress.xlsx"
        
        if not excel_file.exists():
            raise HTTPException(status_code=404, detail="No test data found for user")
        
        # Load latest test data for context
        df_dict = {}
        with pd.ExcelFile(excel_file) as xl_file:
            for sheet_name in xl_file.sheet_names:
                df_dict[sheet_name] = pd.read_excel(xl_file, sheet_name=sheet_name)
        
        if not df_dict:
            raise HTTPException(status_code=404, detail="No test data found")
        
        latest_sheet = max(df_dict.keys())
        latest_df = df_dict[latest_sheet]
        
        # Calculate basic performance context
        section_scores = {"VARC": 0, "DILR": 0, "QA": 0}
        for _, row in latest_df.iterrows():
            section = row.get('Section', '')
            marks = row.get('Marks_Obtained', 0)
            if section in section_scores:
                section_scores[section] += marks
        
        total_score = sum(section_scores.values())
        
        # Get dynamic question counts for max scores
        try:
            test_data = load_test_data()
        except DataLoadError as e:
            raise HTTPException(status_code=500, detail=str(e))
        
        test_name = latest_sheet.split('_')[0] if '_' in latest_sheet else "Unknown"
        
        # Find the test data for this specific test
        current_test = None
        for test in test_data:
            if test["name"] == test_name:
                current_test = test
                break
        
        if current_test:
            # Safe dictionary access with defaults
            test_data = current_test.get("data", {})
            varc_section = test_data.get("VARC", [])
            dilr_section = test_data.get("DILR", [])
            qa_section = test_data.get("QA", [])
            
            varc_count = sum(len(q.get("qa_list", [])) for q in varc_section if isinstance(q, dict))
            dilr_count = sum(len(q.get("qa_list", [])) for q in dilr_section if isinstance(q, dict))
            qa_count = sum(len(q.get("qa_list", [])) for q in qa_section if isinstance(q, dict))
            max_scores = {
                "VARC": varc_count * 3,
                "DILR": dilr_count * 3,
                "QA": qa_count * 3
            }
            total_max = sum(max_scores.values())
        else:
            # Fallback to default values
            max_scores = {"VARC": 72, "DILR": 60, "QA": 66}
            total_max = 198
        
        # Create context for the AI
        context = f"""
User: {username}
Test: {test_name}
Performance Context:
- Total Score: {total_score}/{total_max} ({total_score/total_max*100:.1f}%)
- VARC: {section_scores['VARC']}/{max_scores['VARC']} ({section_scores['VARC']/max_scores['VARC']*100:.1f}%)
- DILR: {section_scores['DILR']}/{max_scores['DILR']} ({section_scores['DILR']/max_scores['DILR']*100:.1f}%)
- QA: {section_scores['QA']}/{max_scores['QA']} ({section_scores['QA']/max_scores['QA']*100:.1f}%)

User's Follow-up Question: {question}
"""
        
        # Generate AI response using the analysis module
        from ai_analysis import ai_analyzer
        
        followup_prompt = f"""
You are an expert CAT coach helping a student with a follow-up question about their performance analysis.

Context:
{context}

Provide a helpful, specific, and actionable response to the user's follow-up question. Be encouraging and practical.

Guidelines:
- Answer directly and specifically to their question
- Provide actionable advice they can implement immediately
- Reference their actual performance data when relevant
- Be encouraging while being honest about areas for improvement
- Keep the response concise but comprehensive
- Use practical examples and specific strategies
"""
        
        # Use the AI analyzer to get response
        from langchain_core.prompts import ChatPromptTemplate
        from langchain_core.output_parsers import StrOutputParser
        
        prompt = ChatPromptTemplate.from_template(followup_prompt)
        chain = prompt | ai_analyzer.llm | StrOutputParser()
        
        ai_response = await chain.ainvoke({"context": context, "question": question})
        
        return {
            "status": "success",
            "response": ai_response
        }
        
    except Exception as e:
        print(f"Error in AI follow-up for {username}: {e}")
        # Provide a helpful fallback response
        fallback_response = f"""
I understand you're asking: "{question}"

While I'm having trouble accessing the AI system right now, here are some general suggestions:

**For VARC improvement**: Focus on reading comprehension speed, vocabulary building, and grammar practice. Practice 2-3 RC passages daily.

**For DILR improvement**: Work on pattern recognition, logical sequencing, and data interpretation. Practice different question types regularly.

**For QA improvement**: Strengthen fundamentals in arithmetic, algebra, and geometry. Focus on speed and accuracy with regular practice.

**General CAT strategy**: 
- Take regular mock tests
- Analyze your mistakes thoroughly  
- Focus on your strongest areas first
- Manage time effectively during the exam

Please try your follow-up question again in a moment, or check your AI configuration.
"""
        
        return {
            "status": "success", 
            "response": fallback_response
        }


@app.get("/api/download-report/{username}")
async def download_test_report(username: str):
    """Generate and download comprehensive PDF test report"""
    
    # First check if user has an active session - use that for the most current data
    current_session_data = None
    for session_id, session in active_sessions.items():
        if session.get("username") == username and not session.get("is_paused", False):
            current_session_data = session
            # Save the current session to Excel first
            print(f"Found active session for {username}, saving current data...")
            await save_session_data(session_id)
            break
    
    # Sanitize username for filename to prevent path traversal and invalid characters
    safe_username = sanitize_filename(username)
    excel_file = USER_DATA_DIR / f"{safe_username}_progress.xlsx"
    
    if not excel_file.exists():
        raise HTTPException(status_code=404, detail="No test data found for user")
    
    try:
        # Load the latest test data
        df_dict = {}
        with pd.ExcelFile(excel_file) as xl_file:
            for sheet_name in xl_file.sheet_names:
                df_dict[sheet_name] = pd.read_excel(xl_file, sheet_name=sheet_name)
        
        if not df_dict:
            raise HTTPException(status_code=404, detail="No test data found")
        
        # Get the latest test
        latest_sheet = max(df_dict.keys())
        latest_df = df_dict[latest_sheet]
        test_name = latest_sheet.split('_')[0] if '_' in latest_sheet else "CAT Mock Test"
        
        # Load the original test data for questions and solutions
        try:
            full_test_data = load_test_data()
        except DataLoadError as e:
            raise HTTPException(status_code=500, detail=f"Failed to load test data: {str(e)}")
        
        # Find the matching test data (try exact match first, then partial match)
        test_data = None
        matching_test = None
        for test in full_test_data:
            if test["name"] == test_name:
                matching_test = test
                test_data = test.get("data")  # Extract the "data" part
                break
        
        # If no exact match, try partial matching
        if not test_data:
            for test in full_test_data:
                # Try matching with common variations
                test_json_name = test["name"]
                if (test_name.lower() in test_json_name.lower() or 
                    test_json_name.lower() in test_name.lower() or
                    test_name.replace("-", "").replace("_", "").lower() == test_json_name.replace("-", "").replace("_", "").lower()):
                    matching_test = test
                    test_data = test.get("data")  # Extract the "data" part
                    break
        
        # If still no match, use the first available test data as fallback
        if not test_data and full_test_data:
            print(f"Warning: No exact match for test '{test_name}', using first available test data: {full_test_data[0]['name']}")
            matching_test = full_test_data[0]
            test_data = matching_test.get("data")  # Extract the "data" part
            test_name = matching_test.get("name", test_name)  # Update test name to match the data we're using
        
        if not test_data:
            raise HTTPException(status_code=404, detail="No test data available in the system")
        
        # Validate test_data structure
        if not isinstance(test_data, dict) or "VARC" not in test_data or "DILR" not in test_data or "QA" not in test_data:
            raise HTTPException(status_code=500, detail="Invalid test data structure")
        
        # Generate PDF
        pdf_buffer = BytesIO()
        pdf_content = generate_comprehensive_pdf_report(
            username, latest_df, test_data, test_name
        )
        
        pdf_buffer.write(pdf_content)
        pdf_buffer.seek(0)
        
        # Return PDF as response
        from fastapi.responses import Response
        
        filename = f"CAT_Test_Report_{username}_{test_name}_{datetime.now().strftime('%Y%m%d')}.pdf"
        
        return Response(
            content=pdf_buffer.getvalue(),
            media_type="application/pdf",
            headers={
                "Content-Disposition": f"attachment; filename={filename}"
            }
        )
        
    except Exception as e:
        print(f"Error generating PDF report for {username}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to generate PDF report: {str(e)}")


def extract_answer_from_html(html_answer: str, question_type: str = "") -> str:
    """Extract the option letter/number from an HTML-formatted answer.
    
    Handles formats like "<p>b) text...</p>" -> "b"
    or "<p>1) text...</p>" -> "1"
    For MCQ questions, returns just the letter/number.
    For TITA questions, returns the cleaned text.
    
    Args:
        html_answer: The HTML-formatted answer string
        question_type: The type of question (MCQ or TITA)
        
    Returns:
        The extracted answer (letter/number for MCQ, cleaned text for TITA)
    """
    if not html_answer:
        return ""
    
    # For TITA questions, return cleaned text without option extraction
    if question_type == "Type in the Answer" or question_type == "TITA":
        return clean_html_text(html_answer).strip()
    
    # For MCQ, extract option letter/number
    cleaned = clean_html_text(html_answer).strip()
    
    # Match pattern like "b) text" or "1) text" - extract the letter/number before )
    match = re.match(r'^([a-zA-Z0-9]+)\)\s*', cleaned)
    if match:
        return match.group(1).lower()  # Return lowercase letter or number as string
    
    # Fallback: if it's just a single letter/number, return it
    if len(cleaned) == 1 and re.match(r'[a-zA-Z0-9]', cleaned):
        return cleaned.lower()
    
    # If no match, return cleaned text (shouldn't happen for MCQ, but safe fallback)
    return cleaned

def clean_html_text(html_text):
    """Clean HTML tags and entities from text for PDF display, with basic LaTeX formatting"""
    if not html_text:
        return ""
    
    # Convert string to avoid issues
    text = str(html_text)
    
    # Basic LaTeX to readable format conversions (safe, simple ones only)
    try:
        # Fractions: \frac{a}{b} -> (a/b)
        text = re.sub(r'\\frac\{([^}]+)\}\{([^}]+)\}', r'(\1/\2)', text)
        
        # Square roots: \sqrt{x} -> √(x)
        text = re.sub(r'\\sqrt\{([^}]+)\}', r'√(\1)', text)
        
        # Mathematical symbols
        text = text.replace(r'\times', '×')
        text = text.replace(r'\div', '÷')
        text = text.replace(r'\pm', '±')
        text = text.replace(r'\pi', 'π')
        
        # Remove remaining LaTeX commands (keep the content) - safe approach
        text = re.sub(r'\\[a-zA-Z]+\{([^}]*)\}', r'\1', text)
        text = re.sub(r'\\[a-zA-Z]+', '', text)
    except:
        # If any LaTeX processing fails, continue with original text
        pass
    
    # Remove HTML tags
    clean_text = re.sub(r'<[^>]+>', '', text)
    
    # Replace common HTML entities
    clean_text = clean_text.replace('&nbsp;', ' ')
    clean_text = clean_text.replace('&amp;', '&')
    clean_text = clean_text.replace('&lt;', '<')
    clean_text = clean_text.replace('&gt;', '>')
    clean_text = clean_text.replace('&quot;', '"')
    clean_text = clean_text.replace('&#39;', "'")
    
    # Clean up whitespace
    clean_text = ' '.join(clean_text.split())
    
    return clean_text


def generate_comprehensive_pdf_report(username, test_df, test_data, test_name):
    """Generate comprehensive PDF report with all question details"""
    
    buffer = BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, topMargin=0.5*inch, bottomMargin=0.5*inch)
    
    # Define styles
    styles = getSampleStyleSheet()
    
    title_style = ParagraphStyle(
        'CustomTitle',
        parent=styles['Title'],
        fontSize=18,
        spaceAfter=20,
        textColor=colors.darkblue,
        alignment=TA_CENTER
    )
    
    heading_style = ParagraphStyle(
        'CustomHeading',
        parent=styles['Heading1'],
        fontSize=14,
        spaceAfter=10,
        textColor=colors.darkblue,
        spaceBefore=15
    )
    
    subheading_style = ParagraphStyle(
        'CustomSubheading',
        parent=styles['Heading2'],
        fontSize=12,
        spaceAfter=8,
        textColor=colors.darkgreen,
        spaceBefore=10
    )
    
    normal_style = ParagraphStyle(
        'CustomNormal',
        parent=styles['Normal'],
        fontSize=10,
        spaceAfter=6
    )
    
    # Build PDF content
    story = []
    
    # Title Page
    story.append(Paragraph(f"CAT Mock Test Report", title_style))
    story.append(Paragraph(f"Test: {test_name}", heading_style))
    story.append(Paragraph(f"Student: {username}", normal_style))
    story.append(Paragraph(f"Report Generated: {datetime.now().strftime('%B %d, %Y at %I:%M %p')}", normal_style))
    story.append(Spacer(1, 0.3*inch))
    
    # Calculate performance summary
    section_scores = {"VARC": 0, "DILR": 0, "QA": 0}
    
    # Get dynamic question counts (with validation)
    varc_section = test_data.get("VARC", [])
    dilr_section = test_data.get("DILR", [])
    qa_section = test_data.get("QA", [])
    
    varc_count = sum(len(q.get("qa_list", [])) for q in varc_section if isinstance(q, dict) and isinstance(q.get("qa_list"), list))
    dilr_count = sum(len(q.get("qa_list", [])) for q in dilr_section if isinstance(q, dict) and isinstance(q.get("qa_list"), list))
    qa_count = sum(len(q.get("qa_list", [])) for q in qa_section if isinstance(q, dict) and isinstance(q.get("qa_list"), list))
    
    section_stats = {"VARC": {"attempted": 0, "correct": 0, "total": varc_count}, 
                     "DILR": {"attempted": 0, "correct": 0, "total": dilr_count}, 
                     "QA": {"attempted": 0, "correct": 0, "total": qa_count}}
    
    for _, row in test_df.iterrows():
        section = row.get('Section', '')
        marks = row.get('Marks_Obtained', 0)
        user_answer = row.get('User_Answer', '')
        correct_answer = row.get('Correct_Answer', '')
        
        if section in section_scores:
            # Always add marks (including negative marks and zeros)
            section_scores[section] += marks
            
            # Only count as attempted if there's a real answer
            if user_answer and str(user_answer).strip() != '' and str(user_answer).strip() != 'nan':
                section_stats[section]["attempted"] += 1
                if str(user_answer).strip().lower() == str(correct_answer).strip().lower():
                    section_stats[section]["correct"] += 1
    
    total_score = sum(section_scores.values())
    total_attempted = sum(stats["attempted"] for stats in section_stats.values())
    total_correct = sum(stats["correct"] for stats in section_stats.values())
    
    # Performance Summary Table
    story.append(Paragraph("Performance Summary", heading_style))
    
    # Calculate dynamic totals
    total_questions = varc_count + dilr_count + qa_count
    total_max_score = total_questions * 3
    
    # Calculate percentages safely (avoid division by zero)
    overall_percent = (total_score/total_max_score*100) if total_max_score > 0 else 0
    attempted_percent = (total_attempted/total_questions*100) if total_questions > 0 else 0
    correct_percent = (total_correct/total_attempted*100) if total_attempted > 0 else 0
    
    varc_max = varc_count * 3
    dilr_max = dilr_count * 3
    qa_max = qa_count * 3
    
    varc_percent = (section_scores["VARC"]/varc_max*100) if varc_max > 0 else 0
    dilr_percent = (section_scores["DILR"]/dilr_max*100) if dilr_max > 0 else 0
    qa_percent = (section_scores["QA"]/qa_max*100) if qa_max > 0 else 0
    
    summary_data = [
        ['Metric', 'Score', 'Details'],
        ['Overall Score', f'{total_score}/{total_max_score}', f'{overall_percent:.1f}%'],
        ['Questions Attempted', f'{total_attempted}/{total_questions}', f'{attempted_percent:.1f}%'],
        ['Correct Answers', f'{total_correct}/{total_attempted}' if total_attempted > 0 else '0/0', f'{correct_percent:.1f}%' if total_attempted > 0 else 'N/A'],
        ['VARC Score', f'{section_scores["VARC"]}/{varc_max}', f'{varc_percent:.1f}%'],
        ['DILR Score', f'{section_scores["DILR"]}/{dilr_max}', f'{dilr_percent:.1f}%'],
        ['QA Score', f'{section_scores["QA"]}/{qa_max}', f'{qa_percent:.1f}%'],
    ]
    
    summary_table = Table(summary_data, colWidths=[2.5*inch, 1.5*inch, 1.5*inch])
    summary_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.darkblue),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, 0), 12),
        ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
        ('BACKGROUND', (0, 1), (-1, -1), colors.beige),
        ('GRID', (0, 0), (-1, -1), 1, colors.black)
    ]))
    
    story.append(summary_table)
    story.append(PageBreak())
    
    # Detailed Question Analysis
    story.append(Paragraph("Detailed Question Analysis", heading_style))
    
    # Create question mapping from test data
    question_map = {}
    for section_name, section_data in test_data.items():
        if not isinstance(section_data, list):
            continue
        for group in section_data:
            if group.get("qa_list"):
                for question in group["qa_list"]:
                    # Create question ID based on section and question number
                    question_num = question.get("question_num")
                    if isinstance(question_num, list):
                        question_num = question_num[0]
                    question_id = f"{section_name}_{question_num}"
                    
                    # Extract answer from HTML format for consistent comparison
                    raw_answer = question.get("answer", "")
                    question_type = question.get("question_type", "")
                    extracted_answer = extract_answer_from_html(raw_answer, question_type)
                    
                    question_map[question_id] = {
                        "question": question.get("question", ""),
                        "context": group.get("context", ""),
                        "options": question.get("options"),
                        "answer": extracted_answer,  # Store extracted answer (e.g., "b" instead of "<p>b) text...</p>")
                        "solution": question.get("solution", ""),
                        "question_type": question_type
                    }
    
    current_section = None
    question_counter = 1
    
    # Sort by section order
    section_order = {"VARC": 1, "DILR": 2, "QA": 3}
    sorted_df = test_df.sort_values(by=['Section', 'Question_ID'], key=lambda x: x.map(lambda val: (section_order.get(val.split('_')[0], 4), val) if isinstance(val, str) and '_' in val else (4, val)))
    
    # Filter to only show answered questions in PDF
    answered_questions_df = sorted_df[
        (sorted_df['User_Answer'].notna()) & 
        (sorted_df['User_Answer'].astype(str).str.strip() != '') & 
        (sorted_df['User_Answer'].astype(str).str.strip() != 'nan')
    ]
    
    if answered_questions_df.empty:
        story.append(Paragraph("No questions were answered in this test.", normal_style))
    else:
        story.append(Paragraph(f"Showing {len(answered_questions_df)} answered questions out of {len(sorted_df)} total questions.", normal_style))
        story.append(Spacer(1, 0.2*inch))
    
    for _, row in answered_questions_df.iterrows():
        question_id = row.get('Question_ID', '')
        section = row.get('Section', '')
        user_answer = row.get('User_Answer', '')
        correct_answer = row.get('Correct_Answer', '')
        marks_obtained = row.get('Marks_Obtained', 0)
        question_type = row.get('Question_Type', '')
        
        # Skip if still somehow empty (extra safety)
        if not user_answer or str(user_answer).strip() == '' or str(user_answer).strip() == 'nan':
            continue
        
        # Section header
        if section != current_section:
            if current_section is not None:
                story.append(PageBreak())
            current_section = section
            section_full_name = {
                'VARC': 'Verbal Ability and Reading Comprehension',
                'DILR': 'Data Interpretation and Logical Reasoning',
                'QA': 'Quantitative Ability'
            }.get(section, section)
            story.append(Paragraph(f"{section_full_name} ({section})", heading_style))
        
        # Get question data
        question_data = question_map.get(question_id, {})
        
        # Question header with status and color coding
        if marks_obtained > 0:
            status = "✓ Correct"
            # Create green style for correct answers
            question_header_style = ParagraphStyle(
                'CorrectQuestionHeader',
                parent=subheading_style,
                textColor=colors.green,
                fontSize=12,
                spaceAfter=8,
                spaceBefore=10
            )
        elif user_answer and str(user_answer).strip():
            status = "✗ Incorrect"  
            # Create red style for incorrect answers
            question_header_style = ParagraphStyle(
                'IncorrectQuestionHeader', 
                parent=subheading_style,
                textColor=colors.red,
                fontSize=12,
                spaceAfter=8,
                spaceBefore=10
            )
        else:
            status = "— Not Attempted"
            # Use normal style for not attempted
            question_header_style = subheading_style
        
        story.append(Paragraph(f"Question {question_counter}: {status} ({marks_obtained:+} marks)", question_header_style))
        
        # Context (if any)
        context = question_data.get("context", "")
        if context and context.strip():
            context_text = clean_html_text(context)
            if len(context_text) > 50:  # Only show context if it's substantial
                story.append(Paragraph(f"<b>Context:</b> {context_text[:500]}{'...' if len(context_text) > 500 else ''}", normal_style))
        
        # Question text
        question_text = question_data.get("question", "")
        if question_text:
            question_clean = clean_html_text(question_text)
            story.append(Paragraph(f"<b>Question:</b> {question_clean}", normal_style))
        
        # Options for MCQ
        if question_data.get("options") and question_type == "Multiple Choice Question":
            story.append(Paragraph("<b>Options:</b>", normal_style))
            
            # Normalize answers for comparison (handle both extracted and HTML formats)
            normalized_user_answer = str(user_answer).strip().lower() if user_answer else ""
            # Use correct_answer from Excel (already extracted), fallback to question_map answer
            correct_answer_from_map = str(question_data.get("answer", "")).strip().lower()
            normalized_correct_answer = str(correct_answer).strip().lower() if correct_answer else correct_answer_from_map
            
            # If correct_answer appears to be HTML, extract it
            if normalized_correct_answer and ('<' in normalized_correct_answer or '>' in normalized_correct_answer):
                normalized_correct_answer = extract_answer_from_html(correct_answer, question_type).lower()
            
            for i, option in enumerate(question_data["options"]):
                option_letter = chr(ord('a') + i)
                option_text = clean_html_text(option)
                
                # Compare with normalized answers
                option_letter_lower = option_letter.lower()
                is_user_choice = normalized_user_answer == option_letter_lower
                is_correct_answer = normalized_correct_answer == option_letter_lower
                
                prefix = ""
                if is_user_choice and is_correct_answer:
                    prefix = "✓ [Your Choice - Correct] "
                elif is_user_choice:
                    prefix = "✗ [Your Choice - Incorrect] "
                elif is_correct_answer:
                    prefix = "✓ [Correct Answer] "
                
                story.append(Paragraph(f"   {option_letter}) {prefix}{option_text}", normal_style))
        
        # For TITA questions
        elif question_type == "Type in the Answer":
            story.append(Paragraph(f"<b>Your Answer:</b> {user_answer if user_answer and str(user_answer).strip() else 'Not Attempted'}", normal_style))
            story.append(Paragraph(f"<b>Correct Answer:</b> {correct_answer}", normal_style))
        
        # Solution
        solution = question_data.get("solution", "")
        if solution and solution.strip() and "SOLUTION NOT FOUND" not in solution.upper():
            solution_text = clean_html_text(solution)
            story.append(Paragraph(f"<b>Solution:</b> {solution_text[:800]}{'...' if len(solution_text) > 800 else ''}", normal_style))
        else:
            story.append(Paragraph("<b>Solution:</b> Solution not available", normal_style))
        
        story.append(Spacer(1, 0.2*inch))
        question_counter += 1
    
    # Build PDF
    doc.build(story)
    buffer.seek(0)
    return buffer.getvalue()


def calculate_detailed_time_analysis(question_records: list) -> dict:
    """Calculate detailed time analysis from question data"""
    if not question_records:
        return {"total_time": 0, "avg_per_question": 0, "section_times": {}}
    
    section_times = {"VARC": [], "DILR": [], "QA": []}
    total_time = 0
    attempted_count = 0
    
    for record in question_records:
        time_spent = record.get('Time_Spent', 0)
        section = record.get('Section', '')
        user_answer = record.get('User_Answer', '')
        
        if time_spent > 0:
            total_time += time_spent
            if section in section_times:
                section_times[section].append(time_spent)
            
            if user_answer and str(user_answer).strip():
                attempted_count += 1
    
    # Calculate averages
    avg_per_question = total_time / attempted_count if attempted_count > 0 else 0
    
    section_averages = {}
    for section, times in section_times.items():
        section_averages[section] = {
            "total_time": sum(times),
            "avg_time": sum(times) / len(times) if times else 0,
            "questions_with_time": len(times)
        }
    
    return {
        "total_time": total_time,
        "total_time_formatted": format_time_human(total_time),
        "avg_per_question": avg_per_question,
        "avg_per_question_formatted": format_time_human(avg_per_question),
        "section_times": section_averages,
        "attempted_count": attempted_count
    }

def calculate_performance_insights(question_records: list, section_scores: dict) -> dict:
    """Calculate detailed performance insights"""
    insights = {
        "section_analysis": {"VARC": {}, "DILR": {}, "QA": {}},
        "question_type_performance": {"MCQ": {"attempted": 0, "correct": 0}, "TITA": {"attempted": 0, "correct": 0}},
        "difficulty_patterns": {},
        "time_efficiency": {}
    }
    
    # Initialize all sections properly
    for section in ["VARC", "DILR", "QA"]:
        insights["section_analysis"][section] = {
            "attempted": 0, 
            "correct": 0, 
            "total_time": 0, 
            "efficiency": 0,
            "accuracy": 0,
            "avg_time_per_question": 0
        }
    
    if not question_records:
        return insights
    
    for record in question_records:
        section = record.get('Section', '')
        question_type = record.get('Question_Type', '')
        user_answer = record.get('User_Answer', '')
        correct_answer = record.get('Correct_Answer', '')
        time_spent = record.get('Time_Spent', 0)
        
        # Only process valid sections
        if section not in insights["section_analysis"]:
            continue
            
        # Track attempts and correctness
        if user_answer and str(user_answer).strip():
            insights["section_analysis"][section]["attempted"] += 1
            insights["section_analysis"][section]["total_time"] += time_spent
            
            is_correct = str(user_answer).strip().lower() == str(correct_answer).strip().lower()
            if is_correct:
                insights["section_analysis"][section]["correct"] += 1
            
            # Question type analysis
            q_type = "MCQ" if "Multiple Choice" in str(question_type) else "TITA"
            insights["question_type_performance"][q_type]["attempted"] += 1
            if is_correct:
                insights["question_type_performance"][q_type]["correct"] += 1
    
    # Calculate efficiency metrics safely
    for section in insights["section_analysis"]:
        data = insights["section_analysis"][section]
        if data.get("attempted", 0) > 0:
            data["accuracy"] = data["correct"] / data["attempted"] * 100
            data["avg_time_per_question"] = data["total_time"] / data["attempted"]
            data["efficiency"] = (data["correct"] * 3) / (data["total_time"] / 60) if data["total_time"] > 0 else 0
    
    return insights

def format_time_human(seconds: float) -> str:
    """Format time in human readable format"""
    if seconds < 60:
        return f"{int(seconds)} secs"
    elif seconds < 3600:
        mins = int(seconds // 60)
        secs = int(seconds % 60)
        return f"{mins} mins {secs} secs" if secs > 0 else f"{mins} mins"
    else:
        hours = int(seconds // 3600)
        mins = int((seconds % 3600) // 60)
        return f"{hours}h {mins}m"

def generate_basic_analysis(section_scores: dict, total_score: int, test_name: str = None) -> str:
    """Generate basic analysis when AI is not available
    
    Raises:
        DataLoadError: If test data cannot be loaded
    """
    # Get dynamic question counts
    try:
        test_data = load_test_data()
    except DataLoadError as e:
        # For non-request context, raise DataLoadError
        # Callers in request handlers will catch and convert to HTTPException
        raise
    
    # Find the test data for this specific test
    current_test = None
    if test_name:
        for test in test_data:
            if test["name"] == test_name:
                current_test = test
                break
    
    if current_test:
        # Safe access to test data sections with validation
        test_data_dict = current_test.get("data", {})
        if not isinstance(test_data_dict, dict):
            test_data_dict = {}
        
        varc_section = test_data_dict.get("VARC", [])
        dilr_section = test_data_dict.get("DILR", [])
        qa_section = test_data_dict.get("QA", [])
        
        # Safe calculation of question counts with validation
        varc_count = 0
        if isinstance(varc_section, list):
            for q in varc_section:
                if isinstance(q, dict) and "qa_list" in q:
                    varc_count += len(q["qa_list"]) if isinstance(q["qa_list"], list) else 0
        
        dilr_count = 0
        if isinstance(dilr_section, list):
            for q in dilr_section:
                if isinstance(q, dict) and "qa_list" in q:
                    dilr_count += len(q["qa_list"]) if isinstance(q["qa_list"], list) else 0
        
        qa_count = 0
        if isinstance(qa_section, list):
            for q in qa_section:
                if isinstance(q, dict) and "qa_list" in q:
                    qa_count += len(q["qa_list"]) if isinstance(q["qa_list"], list) else 0
        
        section_max = {
            "VARC": varc_count * 3,
            "DILR": dilr_count * 3,
            "QA": qa_count * 3
        }
        total_max = sum(section_max.values())
    else:
        # Fallback to default values
        section_max = {"VARC": 72, "DILR": 60, "QA": 66}
        total_max = 198
    
    # Find best and worst sections (safe division)
    section_percentages = {k: (v/section_max[k]*100) if section_max.get(k, 0) > 0 else 0 for k, v in section_scores.items()}
    
    # Only find best/worst if we have valid percentages
    if section_percentages:
        best_section = max(section_percentages.keys(), key=section_percentages.get)
        worst_section = min(section_percentages.keys(), key=section_percentages.get)
    else:
        best_section = "N/A"
        worst_section = "N/A"
    
    # Calculate overall percentage safely
    overall_percent = (total_score/total_max*100) if total_max > 0 else 0
    
    analysis = f"""
## 📊 CAT Performance Analysis

### Overall Performance  
- **Total Score:** {total_score}/{total_max} ({overall_percent:.1f}%)
- **Performance Level:** {'Excellent' if total_score > total_max*0.7 else 'Good' if total_score > total_max*0.5 else 'Average' if total_score > total_max*0.3 else 'Needs Improvement'}

### Section-wise Marks Breakdown
- **VARC (Verbal):** {section_scores['VARC']}/{section_max['VARC']} marks ({section_percentages['VARC']:.1f}%)
- **DILR (Data Interpretation):** {section_scores['DILR']}/{section_max['DILR']} marks ({section_percentages['DILR']:.1f}%)  
- **QA (Quantitative):** {section_scores['QA']}/{section_max['QA']} marks ({section_percentages['QA']:.1f}%)

### Key Insights
- **Strongest Section:** {best_section} ({section_percentages[best_section]:.1f}%)
- **Needs Improvement:** {worst_section} ({section_percentages[worst_section]:.1f}%)
- **Score Distribution:** {'Balanced' if max(section_percentages.values()) - min(section_percentages.values()) < 20 else 'Unbalanced - focus on weak areas'}

### Recommendations
1. **Immediate Focus:** Strengthen {worst_section} - aim for 60%+ in this section
2. **Maintain Strength:** Keep practicing {best_section} to maintain your edge
3. **Time Management:** Practice 40-minute section-wise time allocation
4. **Target Score:** Work towards crossing 100+ total marks for competitive percentile

### Next Steps
- Take more mock tests in {worst_section} 
- Analyze mistakes in failed questions
- Practice speed with accuracy in {best_section}

*💡 Enable AI features (OpenAI API key or local LLM) for detailed, personalized insights and improvement strategies.*
    """
    return analysis.strip()


if __name__ == "__main__":
    import uvicorn
    
    # Get configuration from environment
    host = os.getenv("APP_HOST", "0.0.0.0")
    port = int(os.getenv("APP_PORT", 8080))
    debug = os.getenv("DEBUG", "False").lower() == "true"
    
    print(f"🚀 Starting CAT Mock Test Portal on {host}:{port}")
    print(f"📱 Local access: http://localhost:{port}")
    if host == "0.0.0.0":
        print("🌐 Network access: Available on all interfaces")
    print("💡 For public access via ngrok, use: python start_with_ngrok.py")
    
    uvicorn.run(
        "app:app", 
        host=host, 
        port=port, 
        reload=debug,
        log_level="info" if not debug else "debug"
    )
