#!/usr/bin/env python3
"""
CAT Mock Test Portal - Vercel Optimized Version (Improved)
Handles file storage properly for serverless environment
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

# Import AI analysis module (optional)
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
from fastapi.responses import HTMLResponse, FileResponse, Response
from pydantic import BaseModel, Field
import pandas as pd

# Initialize FastAPI app
app = FastAPI(
    title="CAT Mock Test Portal",
    description="A comprehensive CAT exam mock test platform",
    version="1.0.0"
)

# Data directories - use absolute paths for Vercel
if os.getenv("VERCEL"):
    # Running on Vercel
    DATA_DIR = Path("/var/task/data")
    USER_DATA_DIR = Path("/tmp/user_data")  # Only /tmp is writable
    FRONTEND_DIR = Path("/var/task/frontend")
else:
    # Running locally
    DATA_DIR = Path("data")
    USER_DATA_DIR = Path("user_data")
    FRONTEND_DIR = Path("frontend")

# Create directories if they don't exist
USER_DATA_DIR.mkdir(exist_ok=True)
FRONTEND_DIR.mkdir(exist_ok=True)

# In-memory storage for active sessions (in production, use Redis)
active_sessions: Dict[str, Dict] = {}
users_db: Dict[str, Dict] = {}

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
    flags: Dict[str, str] = {}
    time_started: datetime
    time_remaining: int
    section_times: Dict[str, int] = {}

class AnswerSubmission(BaseModel):
    session_id: str
    question_id: str
    answer: str
    time_spent: int

class BookmarkRequest(BaseModel):
    session_id: str
    question_id: str
    action: str

class FlagRequest(BaseModel):
    session_id: str
    question_id: str
    color: str

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

# Load users from file (temporary storage for demo)
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

# Save users to file (temporary storage for demo)
def save_users():
    """Save users to JSON file"""
    users_file = USER_DATA_DIR / "users.json"
    with open(users_file, "w") as f:
        json.dump(users_db, f, indent=2)

# Initialize users database
users_db = load_users()

# API Routes

@app.get("/")
async def root():
    """Serve the main application page"""
    return FileResponse("frontend/index.html")

@app.head("/")
async def root_head():
    """Handle HEAD requests for the main page"""
    return FileResponse("frontend/index.html")

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
    
    # Clean up old sessions for this user
    sessions_to_remove = []
    for sid, session in active_sessions.items():
        if session.get("username") == username:
            if not session.get("is_paused", False):
                sessions_to_remove.append(sid)
    
    for sid in sessions_to_remove:
        del active_sessions[sid]
    
    # Generate session ID
    session_id = str(uuid.uuid4())
    
    # Create session
    active_sessions[session_id] = {
        "username": username,
        "test_name": test_name,
        "section": "VARC",
        "question_index": 0,
        "answers": {},
        "bookmarks": [],
        "flags": {},
        "time_started": datetime.now(),
        "time_remaining": 7200,  # 120 minutes
        "section_times": {
            "VARC": 2400,  # 40 minutes
            "DILR": 2400,
            "QA": 2400
        },
        "is_paused": False
    }
    
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
    
    return {"message": "Flag updated successfully"}

@app.get("/api/user-stats/{username}")
async def get_user_stats(username: str):
    """Get user's progress statistics - simplified for serverless"""
    # In a real serverless app, you'd store this in a database
    # For now, return basic stats from current session
    user_sessions = [s for s in active_sessions.values() if s.get("username") == username]
    
    if not user_sessions:
        return {
            "total_time": 0,
            "tests_completed": 0,
            "average_score": 0,
            "total_attempts": 0,
            "last_test_date": None,
            "note": "Data is session-based and will reset when function restarts"
        }
    
    # Calculate basic stats from current sessions
    total_answered = sum(len(s.get("answers", {})) for s in user_sessions)
    total_time = sum(
        sum(answer.get("time_spent", 0) for answer in s.get("answers", {}).values())
        for s in user_sessions
    )
    
    return {
        "total_time": total_time,
        "tests_completed": len(user_sessions),
        "average_score": 0,  # Would need to calculate from answers
        "total_attempts": len(user_sessions),
        "last_test_date": max(s.get("time_started", datetime.min) for s in user_sessions).isoformat(),
        "note": "Data is session-based and will reset when function restarts"
    }

@app.get("/api/download-report/{username}")
async def download_test_report(username: str):
    """Generate and download test report - simplified for serverless"""
    # Find user's current session
    user_session = None
    for session in active_sessions.values():
        if session.get("username") == username:
            user_session = session
            break
    
    if not user_session:
        raise HTTPException(status_code=404, detail="No active session found for user")
    
    # Generate simple JSON report instead of Excel/PDF
    report_data = {
        "username": username,
        "test_name": user_session.get("test_name", "Unknown"),
        "session_id": user_session.get("session_id", "Unknown"),
        "answers": user_session.get("answers", {}),
        "bookmarks": user_session.get("bookmarks", []),
        "flags": user_session.get("flags", {}),
        "time_started": user_session.get("time_started", datetime.now()).isoformat(),
        "time_remaining": user_session.get("time_remaining", 0),
        "generated_at": datetime.now().isoformat(),
        "note": "This is a simplified report for serverless deployment"
    }
    
    # Return as JSON download
    return Response(
        content=json.dumps(report_data, indent=2),
        media_type="application/json",
        headers={
            "Content-Disposition": f"attachment; filename={username}_test_report.json"
        }
    )

# Mount static files
app.mount("/static", StaticFiles(directory="frontend"), name="static")

# Vercel handler
def handler(request):
    return app(request)
