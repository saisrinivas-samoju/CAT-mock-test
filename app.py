#!/usr/bin/env python3
"""
CAT Mock Test Portal - FastAPI Backend
Main application entry point for the CAT mock test portal.
"""

import os
import json
import asyncio
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from pathlib import Path
import uuid
import re
from io import BytesIO

# PDF generation imports
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter, A4
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT

# Import AI analysis module
try:
    from ai_analysis import analyze_user_performance, is_ai_available
    AI_ANALYSIS_AVAILABLE = True
except ImportError as e:
    print(f"AI Analysis module not available: {e}")
    AI_ANALYSIS_AVAILABLE = False

# Load environment variables
from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse
from pydantic import BaseModel, Field
import pandas as pd

# Initialize FastAPI app
app = FastAPI(
    title="CAT Mock Test Portal",
    description="A comprehensive CAT exam mock test platform",
    version="1.0.0"
)

# Data directories
DATA_DIR = Path("data")
USER_DATA_DIR = Path("user_data")
FRONTEND_DIR = Path("frontend")

# Create directories if they don't exist
USER_DATA_DIR.mkdir(exist_ok=True)
FRONTEND_DIR.mkdir(exist_ok=True)

# In-memory storage for active sessions (in production, use Redis)
active_sessions: Dict[str, Dict] = {}
users_db: Dict[str, Dict] = {}

# Session persistence file
SESSIONS_FILE = USER_DATA_DIR / "active_sessions.json"

# Pydantic models
class User(BaseModel):
    username: str = Field(..., min_length=3, max_length=20)
    name: str = Field(..., min_length=1, max_length=50)

class LoginRequest(BaseModel):
    username: str

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
    session_id: str
    question_id: str
    answer: str
    time_spent: int  # in seconds

class BookmarkRequest(BaseModel):
    session_id: str
    question_id: str
    action: str  # "add" or "remove"

class FlagRequest(BaseModel):
    session_id: str
    question_id: str
    color: str  # "red", "yellow", "green", or "none"

# Load test data
def load_test_data():
    """Load test data from JSON file"""
    try:
        with open(DATA_DIR / "full_data.json", "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="Test data file not found")
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Invalid test data format")

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
    """Save users to JSON file"""
    users_file = USER_DATA_DIR / "users.json"
    with open(users_file, "w") as f:
        json.dump(users_db, f, indent=2)

# Initialize users database
users_db = load_users()

def load_active_sessions():
    """Load active sessions from JSON file"""
    try:
        if SESSIONS_FILE.exists():
            with open(SESSIONS_FILE, 'r') as f:
                data = json.load(f)
                # Convert datetime strings back to datetime objects
                for session_id, session in data.items():
                    if 'time_started' in session:
                        session['time_started'] = datetime.fromisoformat(session['time_started'])
                return data
    except Exception as e:
        print(f"Error loading sessions: {e}")
    return {}

def save_active_sessions():
    """Save active sessions to JSON file"""
    try:
        # Convert datetime objects to strings for JSON serialization
        sessions_to_save = {}
        for session_id, session in active_sessions.items():
            session_copy = session.copy()
            if 'time_started' in session_copy:
                session_copy['time_started'] = session_copy['time_started'].isoformat()
            sessions_to_save[session_id] = session_copy
        
        with open(SESSIONS_FILE, 'w') as f:
            json.dump(sessions_to_save, f, indent=2)
    except Exception as e:
        print(f"Error saving sessions: {e}")

# Load existing sessions
active_sessions = load_active_sessions()

# Auto-save functionality
async def auto_save_session(session_id: str):
    """Auto-save session data every 30 seconds"""
    while session_id in active_sessions:
        await asyncio.sleep(30)
        if session_id in active_sessions:
            await save_session_data(session_id)

async def save_session_data(session_id: str):
    """Save session data to Excel file with complete test tracking"""
    if session_id not in active_sessions:
        return
    
    session = active_sessions[session_id]
    username = session.get("username")
    test_name = session.get("test_name", "")
    
    if not username or not test_name:
        return
    
    # Create Excel file for user (ensure consistent naming)
    excel_file = USER_DATA_DIR / f"{username}_progress.xlsx"
    
    # Load test data to get all questions
    test_data = load_test_data()
    all_questions = []
    
    # Get all questions from the test
    for test in test_data:
        if test["name"] == test_name:
            # Flatten all questions with their details
            for section_name, section_data in test["data"].items():
                for question_obj in section_data:
                    for qa in question_obj["qa_list"]:
                        question_num = qa['question_num']
                        if isinstance(question_num, list):
                            question_num = question_num[0]
                        
                        question_id = f"{section_name}_{question_num}"
                        all_questions.append({
                            "question_id": question_id,
                            "section": section_name,
                            "question_type": qa["question_type"],
                            "correct_answer": qa["answer"],
                            "question_num": question_num
                        })
            break
    
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
        marks = 0
        if user_answer:  # Question was attempted
            if user_answer == correct_answer:
                marks = 3  # +3 for correct answer
            else:
                if question_type == "Multiple Choice Question":
                    marks = -1  # -1 for wrong MCQ
                else:  # TITA
                    marks = 0   # 0 for wrong TITA
        else:
            marks = 0  # 0 for unattempted
        
        total_score += marks
        
        data.append({
            "Question_ID": question_id,
            "Section": q["section"],
            "Question_Number": q["question_num"],
            "Question_Type": question_type,
            "User_Answer": user_answer,
            "Correct_Answer": correct_answer,
            "Marks_Obtained": marks,
            "Time_Spent": answer_data.get("time_spent", 0),
            "Bookmark_Status": question_id in session.get("bookmarks", []),
            "Flag_Color": session.get("flags", {}).get(question_id, "none"),
            "Attempt_Timestamp": answer_data.get("timestamp", datetime.now().isoformat()),
            "Test_Name": test_name,
            "Total_Score": total_score if question_id == all_questions[-1]["question_id"] else ""  # Only show total in last row
        })
    
    if data:
        df = pd.DataFrame(data)
        sheet_name = f'Attempt_{datetime.now().strftime("%Y%m%d_%H%M%S")}'
        
        try:
            # Create or append to existing Excel file
            if excel_file.exists():
                # Read existing file and add new sheet
                with pd.ExcelWriter(excel_file, mode='a', if_sheet_exists='replace', engine='openpyxl') as writer:
                    df.to_excel(writer, sheet_name=sheet_name, index=False)
            else:
                # Create new file
                with pd.ExcelWriter(excel_file, engine='openpyxl') as writer:
                    df.to_excel(writer, sheet_name=sheet_name, index=False)
            
            print(f"Successfully saved Excel file for {username}")
        except Exception as e:
            print(f"Error saving Excel file for {username}: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to save progress: {str(e)}")

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
    username_lower = user.username.lower()
    
    # Check if username already exists (case-insensitive)
    for existing_username in users_db.keys():
        if existing_username.lower() == username_lower:
            raise HTTPException(status_code=400, detail="Username already exists")
    
    # Store user with original case
    users_db[user.username] = {
        "name": user.name,
        "created_at": datetime.now().isoformat(),
        "total_attempts": 0
    }
    
    save_users()
    
    return {
        "message": "User registered successfully",
        "username": user.username,
        "name": user.name
    }

@app.post("/api/login")
async def login(request: LoginRequest):
    """Login user (username only)"""
    username_lower = request.username.lower()
    
    # Find user (case-insensitive)
    user_data = None
    actual_username = None
    
    for username, data in users_db.items():
        if username.lower() == username_lower:
            user_data = data
            actual_username = username
            break
    
    if not user_data:
        raise HTTPException(status_code=404, detail="User not found")
    
    return {
        "message": "Login successful",
        "username": actual_username,
        "name": user_data["name"]
    }

@app.get("/api/tests")
async def get_available_tests():
    """Get list of available test papers"""
    test_data = load_test_data()
    
    tests = []
    for test in test_data:
        # Count actual questions, not question groups
        varc_count = sum(len(q["qa_list"]) for q in test["data"]["VARC"])
        dilr_count = sum(len(q["qa_list"]) for q in test["data"]["DILR"])
        qa_count = sum(len(q["qa_list"]) for q in test["data"]["QA"])
        
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
    
    # Clean up old sessions for this user to prevent confusion
    sessions_to_remove = []
    for sid, session in active_sessions.items():
        if session.get("username") == username:
            # Keep paused sessions, remove active ones (including old sessions without is_paused field)
            if not session.get("is_paused", False):
                sessions_to_remove.append(sid)
    
    for sid in sessions_to_remove:
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
    
    # Start auto-save task
    asyncio.create_task(auto_save_session(session_id))
    
    return {
        "session_id": session_id,
        "message": "Test session started",
        "section": "VARC",
        "time_remaining": 7200
    }

@app.get("/api/test-data/{test_name}")
async def get_test_data(test_name: str):
    """Get test data for a specific test"""
    test_data = load_test_data()
    
    for test in test_data:
        if test["name"] == test_name:
            return test["data"]
    
    raise HTTPException(status_code=404, detail="Test not found")

@app.get("/api/session/{session_id}")
async def get_session(session_id: str):
    """Get current session state"""
    if session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    session = active_sessions[session_id]
    
    # Calculate remaining time
    elapsed = datetime.now() - session["time_started"]
    remaining = session["time_remaining"] - int(elapsed.total_seconds())
    
    return {
        **session,
        "time_remaining": max(0, remaining),
        "time_started": session["time_started"].isoformat()
    }

@app.post("/api/submit-answer")
async def submit_answer(submission: AnswerSubmission):
    """Submit an answer for a question"""
    if submission.session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    session = active_sessions[submission.session_id]
    
    # Load test data to get correct answer
    test_data = load_test_data()
    correct_answer = ""
    section = ""
    
    # Find correct answer in test data
    for test in test_data:
        if test["name"] == session["test_name"]:
            for section_name, questions in test["data"].items():
                for question_obj in questions:
                    for qa in question_obj["qa_list"]:
                        q_id = f"{section_name}_{qa['question_num']}"
                        if isinstance(qa['question_num'], list):
                            q_id = f"{section_name}_{qa['question_num'][0]}"
                        
                        if q_id == submission.question_id:
                            correct_answer = qa["answer"]
                            section = section_name
                            break
    
    # Store answer
    session["answers"][submission.question_id] = {
        "answer": submission.answer,
        "correct_answer": correct_answer,
        "time_spent": submission.time_spent,
        "timestamp": datetime.now().isoformat(),
        "section": section
    }
    
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
    
    await save_session_data(session_id)
    return {"message": "Session saved successfully"}

@app.post("/api/pause-test")
async def pause_test(request: dict):
    """Pause the current test"""
    session_id = request.get("session_id")
    if session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    session = active_sessions[session_id]
    
    # Save current time remaining
    elapsed = datetime.now() - session["time_started"]
    session["time_remaining"] = session["time_remaining"] - int(elapsed.total_seconds())
    session["paused_at"] = datetime.now().isoformat()
    session["is_paused"] = True
    
    # Save session data to Excel and persist sessions to disk
    await save_session_data(session_id)
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
            not session.get("is_paused", False)):
            
            # Calculate time remaining
            elapsed = datetime.now() - session["time_started"]
            remaining = session["time_remaining"] - int(elapsed.total_seconds())
            
            return {
                "session_id": session_id,
                "test_name": session.get("test_name", "Unknown Test"),
                "section": session.get("section", "VARC"),
                "question_index": session.get("question_index", 0),
                "time_remaining": max(0, remaining),
                "answers": session.get("answers", {}),
                "bookmarks": session.get("bookmarks", []),
                "flags": session.get("flags", {}),
                "is_paused": session.get("is_paused", False)
            }
    
    raise HTTPException(status_code=404, detail="No active session found")

@app.post("/api/cleanup-session")
async def cleanup_session(request: dict):
    """Clean up a specific session"""
    session_id = request.get("session_id")
    if session_id and session_id in active_sessions:
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
    
    # Reset start time to current time
    session["time_started"] = datetime.now()
    session.pop("paused_at", None)
    session["is_paused"] = False
    
    # Save sessions to disk
    save_active_sessions()
    
    # Restart auto-save
    asyncio.create_task(auto_save_session(session_id))
    
    return {"message": "Test resumed successfully"}

@app.get("/api/user-stats/{username}")
async def get_user_stats(username: str):
    """Get user's progress statistics"""
    excel_file = USER_DATA_DIR / f"{username}_progress.xlsx"
    
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

@app.get("/api/user-progress/{username}")
async def get_user_progress(username: str):
    """Get user's test progress and download Excel file"""
    excel_file = USER_DATA_DIR / f"{username}_progress.xlsx"
    
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
    
    excel_file = USER_DATA_DIR / f"{username}_progress.xlsx"
    
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
            analysis_result = await analyze_user_performance(user_performance_data)
            analysis_text = analysis_result.get("analysis", "Analysis not available")
            ai_powered = True
        else:
            analysis_text = generate_basic_analysis(section_scores, total_score)
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
                    section: round((score / section_max_scores[section]) * 100, 1) 
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
        excel_file = USER_DATA_DIR / f"{username}_progress.xlsx"
        
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
        
        # Create context for the AI
        context = f"""
User: {username}
Test: {latest_sheet.split('_')[0] if '_' in latest_sheet else "Recent CAT Mock Test"}
Performance Context:
- Total Score: {total_score}/198 ({total_score/198*100:.1f}%)
- VARC: {section_scores['VARC']}/72 ({section_scores['VARC']/72*100:.1f}%)
- DILR: {section_scores['DILR']}/60 ({section_scores['DILR']/60*100:.1f}%)
- QA: {section_scores['QA']}/66 ({section_scores['QA']/66*100:.1f}%)

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
    
    excel_file = USER_DATA_DIR / f"{username}_progress.xlsx"
    
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
        with open(DATA_DIR / "full_data.json", 'r') as f:
            full_test_data = json.load(f)
        
        # Find the matching test data (try exact match first, then partial match)
        test_data = None
        for test in full_test_data:
            if test["name"] == test_name:
                test_data = test
                break
        
        # If no exact match, try partial matching
        if not test_data:
            for test in full_test_data:
                # Try matching with common variations
                test_json_name = test["name"]
                if (test_name.lower() in test_json_name.lower() or 
                    test_json_name.lower() in test_name.lower() or
                    test_name.replace("-", "").replace("_", "").lower() == test_json_name.replace("-", "").replace("_", "").lower()):
                    test_data = test
                    break
        
        # If still no match, use the first available test data as fallback
        if not test_data and full_test_data:
            print(f"Warning: No exact match for test '{test_name}', using first available test data: {full_test_data[0]['name']}")
            test_data = full_test_data[0]
            test_name = test_data["name"]  # Update test name to match the data we're using
        
        if not test_data:
            raise HTTPException(status_code=404, detail="No test data available in the system")
        
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
    section_stats = {"VARC": {"attempted": 0, "correct": 0, "total": 23}, 
                     "DILR": {"attempted": 0, "correct": 0, "total": 22}, 
                     "QA": {"attempted": 0, "correct": 0, "total": 22}}
    
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
    
    summary_data = [
        ['Metric', 'Score', 'Details'],
        ['Overall Score', f'{total_score}/198', f'{(total_score/198*100):.1f}%'],
        ['Questions Attempted', f'{total_attempted}/66', f'{(total_attempted/66*100):.1f}%'],
        ['Correct Answers', f'{total_correct}/{total_attempted}' if total_attempted > 0 else '0/0', f'{(total_correct/total_attempted*100):.1f}%' if total_attempted > 0 else 'N/A'],
        ['VARC Score', f'{section_scores["VARC"]}/72', f'{(section_scores["VARC"]/72*100):.1f}%'],
        ['DILR Score', f'{section_scores["DILR"]}/60', f'{(section_scores["DILR"]/60*100):.1f}%'],
        ['QA Score', f'{section_scores["QA"]}/66', f'{(section_scores["QA"]/66*100):.1f}%'],
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
    for section_name, section_data in test_data["data"].items():
        for group in section_data:
            if group.get("qa_list"):
                for question in group["qa_list"]:
                    # Create question ID based on section and question number
                    question_num = question.get("question_num")
                    if isinstance(question_num, list):
                        question_num = question_num[0]
                    question_id = f"{section_name}_{question_num}"
                    
                    question_map[question_id] = {
                        "question": question.get("question", ""),
                        "context": group.get("context", ""),
                        "options": question.get("options"),
                        "answer": question.get("answer", ""),
                        "solution": question.get("solution", ""),
                        "question_type": question.get("question_type", "")
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
            for i, option in enumerate(question_data["options"]):
                option_letter = chr(ord('a') + i)
                option_text = clean_html_text(option)
                
                prefix = ""
                if str(user_answer).strip().lower() == option_letter.lower() and str(correct_answer).strip().lower() == option_letter.lower():
                    prefix = "✓ [Your Choice - Correct] "
                elif str(user_answer).strip().lower() == option_letter.lower():
                    prefix = "✗ [Your Choice - Incorrect] "
                elif str(correct_answer).strip().lower() == option_letter.lower():
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

def generate_basic_analysis(section_scores: dict, total_score: int) -> str:
    """Generate basic analysis when AI is not available"""
    section_max = {"VARC": 72, "DILR": 60, "QA": 66}
    
    # Find best and worst sections
    section_percentages = {k: (v/section_max[k])*100 for k, v in section_scores.items()}
    best_section = max(section_percentages.keys(), key=section_percentages.get)
    worst_section = min(section_percentages.keys(), key=section_percentages.get)
    
    analysis = f"""
## 📊 CAT Performance Analysis

### Overall Performance  
- **Total Score:** {total_score}/198 ({total_score/198*100:.1f}%)
- **Performance Level:** {'Excellent' if total_score > 140 else 'Good' if total_score > 100 else 'Average' if total_score > 60 else 'Needs Improvement'}

### Section-wise Marks Breakdown
- **VARC (Verbal):** {section_scores['VARC']}/72 marks ({section_percentages['VARC']:.1f}%)
- **DILR (Data Interpretation):** {section_scores['DILR']}/60 marks ({section_percentages['DILR']:.1f}%)  
- **QA (Quantitative):** {section_scores['QA']}/66 marks ({section_percentages['QA']:.1f}%)

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
