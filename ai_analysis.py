import os
import json
import asyncio
from typing import Dict, List, Any, Optional
from datetime import datetime
import pandas as pd
from pathlib import Path

# Load environment variables
from dotenv import load_dotenv
load_dotenv()

# Define data directory
DATA_DIR = Path(__file__).parent / "data"

from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser


try:
    import openai
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False

class CATAnalysisAI:    
    def __init__(self):
        self.llm = None
        self.initialize_llm()
        self.test_data = None
        self.question_counts = None
        self.load_test_data()
        
    def initialize_llm(self):
        openai_api_key = os.getenv('OPENAI_API_KEY')
        
        if openai_api_key:
            try:
                self.llm = ChatOpenAI()
                print("OpenAI API initialized successfully")
            except Exception as e:
                print(f"OpenAI API initialization failed: {e}")
                self.try_local_llm()
        else:
            print("No OpenAI API key found in environment")
            print("To enable AI features:")
            print("   1. Add OPENAI_API_KEY=sk-your-key to .env file")
            print("   2. Or use local LLM with LM Studio")
            self.try_local_llm()
    
    def load_test_data(self):
        """Load test data and calculate question counts per section"""
        try:
            with open(DATA_DIR / "full_data.json", "r", encoding="utf-8") as f:
                self.test_data = json.load(f)
            
            # Calculate question counts for each test
            self.question_counts = {}
            for test in self.test_data:
                test_name = test["name"]
                varc_count = sum(len(q["qa_list"]) for q in test["data"]["VARC"])
                dilr_count = sum(len(q["qa_list"]) for q in test["data"]["DILR"])
                qa_count = sum(len(q["qa_list"]) for q in test["data"]["QA"])
                
                self.question_counts[test_name] = {
                    'VARC': varc_count,
                    'DILR': dilr_count,
                    'QA': qa_count
                }
            
            print(f"Loaded test data with {len(self.test_data)} tests")
        except Exception as e:
            print(f"Failed to load test data: {e}")
            # Fallback to hardcoded values if data loading fails
            self.question_counts = {
                'default': {'VARC': 72, 'DILR': 60, 'QA': 66}
            }
    
    def get_question_counts(self, test_name: str = None) -> Dict[str, int]:
        """Get question counts for a specific test or default values"""
        if test_name and test_name in self.question_counts:
            return self.question_counts[test_name]
        elif self.question_counts:
            # Return the first available test's counts as default
            return list(self.question_counts.values())[0]
        else:
            # Ultimate fallback
            return {'VARC': 72, 'DILR': 60, 'QA': 66}
    
    def try_local_llm(self):
        """Try to connect to local LLM (LM Studio compatible)"""
        local_base_url = os.getenv('LOCAL_LLM_BASE_URL', 'http://localhost:1234/v1')
        local_model = os.getenv('LOCAL_LLM_MODEL', 'local-model')
        
        try:
            # Try local LLM endpoint (LM Studio default)
            self.llm = ChatOpenAI(
                temperature=0.3,
                model=local_model,
                openai_api_base=local_base_url,
                openai_api_key="not-needed"
            )
            print(f"Local LLM initialized successfully at {local_base_url}")
            print("Using local LLM - no API costs!")
        except Exception as e:
            print(f"Local LLM initialization failed: {e}")
            print("To use local LLM:")
            print("   1. Install LM Studio from https://lmstudio.ai/")
            print("   2. Download a model and start the server")
            print("   3. Ensure it's running on http://localhost:1234")
            print("AI features will be disabled - app will use basic analysis")
            self.llm = None
    
    def is_available(self) -> bool:
        return self.llm is not None
    
    async def analyze_performance(self, user_data: Dict[str, Any], test_name: str = None) -> Dict[str, Any]:
        if not self.is_available():
            return self.generate_fallback_analysis(user_data, test_name)
        
        try:
            analysis_prompt = self.create_analysis_prompt()
            
            formatted_data = self.format_user_data(user_data, test_name)
            
            current_date = datetime.now().strftime("%B %d, %Y")
            cat_exam_date = datetime(2025, 11, 30)
            days_remaining = (cat_exam_date - datetime.now()).days
            
            chain = analysis_prompt | self.llm | StrOutputParser()
            analysis_result = await chain.ainvoke({
                # "user_data": formatted_data,
                "user_data": "Aswathi",
                "current_date": current_date,
                "days_remaining": days_remaining
            })
            
            return {
                "status": "success",
                "analysis": analysis_result,
                "generated_at": datetime.now().isoformat(),
                "source": "ai_generated"
            }
            
        except Exception as e:
            print(f"Error in AI analysis: {e}")
            return self.generate_fallback_analysis(user_data, test_name)
    
    def create_analysis_prompt(self) -> ChatPromptTemplate:
        prompt_template = """
        You are StrategyAI (you can call me SAI 😉) - a no-nonsense CAT exam strategist with 10+ years of experience. I cut through the fluff and give you straight-up actionable insights to boost your CAT score.

        PERSONALITY: Conversational, direct, and Spartan. Zero corporate jargon. I talk like a friend who genuinely wants you to crush this exam.

        CONTEXT:
        - Today's Date: {current_date}
        - CAT Exam Date: November 30, 2025
        - Days Remaining: {days_remaining}

        Student Data:
        {user_data}

        Analyze this performance and give me the real deal:

        ## 🎯 Performance Reality Check
        - Where you stand vs CAT standards (percentile range)
        - What's actually working for you
        - What needs fixing RIGHT NOW

        ## 📊 Section Breakdown
        
        ## VARC (Verbal Ability & Reading Comprehension)
        - What the numbers tell us
        - Time efficiency reality
        - What you need to do differently
        
        ## DILR (Data Interpretation & Logical Reasoning)
        - Performance truth bomb
        - Time management facts
        - Strategic fixes needed
        
        ## QA (Quantitative Ability)
        - Where you actually stand
        - Speed vs accuracy reality
        - Concrete improvement steps

        ## ⏱️ Time Management Truth
        - How you're actually using your 40 minutes per section
        - Where you're bleeding time
        - Smart time allocation strategies that work

        ## 🎯 Strategy Reality Check
        - Your question selection patterns (good or bad?)
        - Accuracy vs speed trade-offs you're making
        - MCQ vs TITA performance comparison
        - Risk-taking behavior analysis

        ## 🚀 Your Next 7-10 Days Action Plan
        - Top 3 immediate focus areas (be specific!)
        - Daily practice routine that fits your schedule
        - Specific techniques for your weak spots
        - One mock test strategy tweak to try

        ## 💡 Insider Strategies
        - Advanced tactics based on your performance pattern
        - CAT traps you're likely falling into
        - Unconventional techniques that could work for you

        ## 🎖️ Your Path Forward
        - Realistic score targets for the next mock
        - What success looks like in 2 weeks
        - When to celebrate small wins

        GUIDELINES:
        - Use SPECIFIC numbers from their performance
        - Give ACTIONABLE advice, not motivational speeches
        - Be HONEST but encouraging
        - Reference actual CAT strategies and patterns
        - Keep it conversational and direct
        - Use emojis but don't overdo it
        - End with "That's the game plan! Now go execute it. 💪"
        - NO email signatures or formal closings
        - Focus on 7-10 day plans, not the entire remaining time (unless they ask for more)
        """
        
        return ChatPromptTemplate.from_template(prompt_template)
    
    def format_user_data(self, user_data: Dict[str, Any], test_name: str = None) -> str:
        formatted = []
        
        formatted.append(f"📋 Test Details:")
        formatted.append(f"- Test: {user_data.get('test_name', 'Unknown')}")
        formatted.append(f"- Date: {user_data.get('date', datetime.now().strftime('%Y-%m-%d'))}")
        formatted.append(f"- Student: {user_data.get('username', 'Unknown')}")
        
        section_scores = user_data.get('section_scores', {})
        total_score = sum(section_scores.values())
        
        # Get dynamic question counts
        question_counts = self.get_question_counts(test_name)
        total_max_score = sum(question_counts.values()) * 3
        
        formatted.append(f"\n🏆 Overall Performance:")
        formatted.append(f"- Total Score: {total_score}/{total_max_score} ({total_score/total_max_score*100:.1f}%)")
        
        formatted.append(f"\n📊 Section-wise Performance:")
        performance_insights = user_data.get('performance_insights', {})
        section_analysis = performance_insights.get('section_analysis', {})
        
        for section in ['VARC', 'DILR', 'QA']:
            max_marks = question_counts[section] * 3
            section_data = section_analysis.get(section, {})
            formatted.append(f"\n{section}:")
            formatted.append(f"  - Score: {section_scores.get(section, 0)}/{max_marks} ({section_scores.get(section, 0)/max_marks*100:.1f}%)")
            formatted.append(f"  - Questions Attempted: {section_data.get('attempted', 0)}")
            formatted.append(f"  - Questions Correct: {section_data.get('correct', 0)}")
            formatted.append(f"  - Section Accuracy: {section_data.get('accuracy', 0):.1f}%")
            formatted.append(f"  - Time Efficiency: {section_data.get('efficiency', 0):.2f} marks/minute")
        
        time_data = user_data.get('time_analysis', {})
        if time_data:
            formatted.append(f"\n⏱️ Time Management Analysis:")
            formatted.append(f"- Total Time Used: {time_data.get('total_time_formatted', 'N/A')}")
            formatted.append(f"- Average per Question: {time_data.get('avg_per_question_formatted', 'N/A')}")
            formatted.append(f"- Questions with Time Data: {time_data.get('attempted_count', 0)}")
            
            section_times = time_data.get('section_times', {})
            for section in ['VARC', 'DILR', 'QA']:
                if section in section_times:
                    sect_time = section_times[section]
                    avg_time_formatted = f"{int(sect_time['avg_time']//60)}m {int(sect_time['avg_time']%60)}s" if sect_time['avg_time'] > 0 else "N/A"
                    formatted.append(f"  - {section} Avg Time: {avg_time_formatted} per question")
        
        if 'question_type_performance' in performance_insights:
            qtype_data = performance_insights['question_type_performance']
            formatted.append(f"\n🎯 Question Type Analysis:")
            for qtype, data in qtype_data.items():
                if data['attempted'] > 0:
                    accuracy = (data['correct'] / data['attempted']) * 100
                    formatted.append(f"- {qtype}: {data['correct']}/{data['attempted']} ({accuracy:.1f}% accuracy)")
        
        formatted.append(f"\n🔍 Performance Patterns:")
        formatted.append(f"- Overall questions attempted: {time_data.get('attempted_count', 0)}/66")
        formatted.append(f"- Overall accuracy: {(sum(s.get('correct', 0) for s in section_analysis.values()) / max(sum(s.get('attempted', 1) for s in section_analysis.values()), 1) * 100):.1f}%")
        
        formatted.append(f"\n💡 Additional Context:")
        formatted.append(f"- This is a CAT mock test analysis")
        formatted.append(f"- CAT marking: +3 correct, -1 wrong MCQ, 0 wrong TITA")
        formatted.append(f"- Target CAT percentile range: 85-99+ (120+ marks)")
        formatted.append(f"- Section time limit: 40 minutes each")
        
        return "\n".join(formatted)
    
    def generate_fallback_analysis(self, user_data: Dict[str, Any], test_name: str = None) -> Dict[str, Any]:
        section_scores = user_data.get('section_scores', {})
        total_score = sum(section_scores.values())
        
        answers = user_data.get('answers', {})
        attempted = len(answers)
        correct = sum(1 for a in answers.values() if a.get('correct', False))
        accuracy = (correct / attempted * 100) if attempted > 0 else 0
        
        current_date = datetime.now().strftime("%B %d, %Y")
        cat_exam_date = datetime(2025, 11, 30)
        days_remaining = (cat_exam_date - datetime.now()).days
        
        # Get dynamic question counts
        question_counts = self.get_question_counts(test_name)
        total_questions = sum(question_counts.values())
        
        analysis = f"""
        Hey there! StrategyAI here (you can call me SAI 😉)
        
        I'm running on basic mode right now, but let me give you the essentials:
        
        ## 🎯 Your Performance Reality Check
        
        **Overall Score:** {total_score}/{total_questions * 3} ({total_score/(total_questions * 3)*100:.1f}%)
        **Today:** {current_date}
        **CAT Exam:** November 30, 2025 ({days_remaining} days to go!)
        
        **Section Breakdown:**
        - VARC: {section_scores.get('VARC', 0)}/{question_counts['VARC']} ({section_scores.get('VARC', 0)/question_counts['VARC']*100:.1f}%)
        - DILR: {section_scores.get('DILR', 0)}/{question_counts['DILR']} ({section_scores.get('DILR', 0)/question_counts['DILR']*100:.1f}%)
        - QA: {section_scores.get('QA', 0)}/{question_counts['QA']} ({section_scores.get('QA', 0)/question_counts['QA']*100:.1f}%)
        
        **Accuracy:** {accuracy:.1f}% ({correct}/{attempted} questions)
        
        ## 🚀 What's Working For You
        {self.identify_strengths(section_scores, test_name)}
        
        ## 🎯 What Needs Your Attention
        {self.identify_weaknesses(section_scores, test_name)}
        
        ## Your Next 7 Days Game Plan
        
        1. **Priority Fix:** Focus on your weakest section first
        2. **Mock Strategy:** Take one more mock this week, focus on accuracy over speed
        3. **Time Practice:** Do 40-minute section-wise practice daily
        4. **Review Ritual:** Spend 30 minutes analyzing wrong answers
        
        ## Quick Wins This Week
        
        - Review all incorrect answers from this mock
        - Practice 10 questions daily from your weak areas
        - Time yourself on every practice set
        - Take notes on patterns in your mistakes
        
        That's your basic game plan! For detailed AI insights, set up the OpenAI API key.
        
        Now go execute it! 💪
        """
        
        return {
            "status": "success",
            "analysis": analysis.strip(),
            "generated_at": datetime.now().isoformat(),
            "source": "programmatic"
        }
    
    def identify_strengths(self, section_scores: Dict[str, int], test_name: str = None) -> str:
        if not section_scores:
            return "- Complete more questions to identify strengths"
        
        max_sections = self.get_question_counts(test_name)
        
        percentages = {}
        for section, score in section_scores.items():
            if section in max_sections:
                percentages[section] = (score / max_sections[section]) * 100
        
        if not percentages:
            return "- Complete the test to identify strengths"
        
        best_section = max(percentages.keys(), key=lambda k: percentages[k])
        best_score = percentages[best_section]
        
        strengths = []
        if best_score > 60:
            strengths.append(f"- Strong performance in {best_section} ({best_score:.1f}%)")
        
        for section, score in percentages.items():
            if score > 50 and section != best_section:
                strengths.append(f"- Good grasp of {section} concepts")
        
        return "\n".join(strengths) if strengths else "- Focus on building foundational concepts"
    
    def identify_weaknesses(self, section_scores: Dict[str, int], test_name: str = None) -> str:
        if not section_scores:
            return "- Complete more questions for detailed analysis"
        
        max_sections = self.get_question_counts(test_name)
        
        percentages = {}
        for section, score in section_scores.items():
            if section in max_sections:
                percentages[section] = (score / max_sections[section]) * 100
        
        if not percentages:
            return "- Complete the test for detailed analysis"
        
        weaknesses = []
        for section, score in percentages.items():
            if score < 40:
                weaknesses.append(f"- {section} needs significant improvement ({score:.1f}%)")
            elif score < 60:
                weaknesses.append(f"- {section} has room for improvement ({score:.1f}%)")
        
        return "\n".join(weaknesses) if weaknesses else "- Overall solid performance, focus on fine-tuning"
    
    async def generate_question_hints(self, question_data: Dict[str, Any]) -> str:
    
        if not self.is_available():
            return "Hey! SAI here 😉 - AI hints are offline right now. Check the solution provided, or set up the OpenAI API for smart hints!"
        
        try:
            hint_prompt = ChatPromptTemplate.from_template("""
            You are StrategyAI (call me SAI 😉) - a direct CAT strategist. A student is stuck on this question. Give them a smart hint WITHOUT spoiling the answer.
            
            Question: {question}
            Question Type: {question_type}
            Options: {options}
            
            Give a strategic nudge:
            - VARC: Point to key passage clues, logical flow, or elimination strategy
            - DILR: Suggest the approach, what data to focus on, logical sequence
            - QA: Hint at the concept/method needed, not the calculation steps
            
            Keep it conversational, encouraging, and brief. End with "Give it another shot! 💪"
            """)
            
            chain = hint_prompt | self.llm | StrOutputParser()
            hint = await chain.ainvoke({
                "question": question_data.get("question", ""),
                "question_type": question_data.get("question_type", ""),
                "options": str(question_data.get("options", []))
            })
            
            return hint
            
        except Exception as e:
            print(f"Error generating hint: {e}")
            return "Oops! SAI's having a moment. Try checking the solution or come back in a bit! 😅"

# Global instance
ai_analyzer = CATAnalysisAI()

async def analyze_user_performance(user_data: Dict[str, Any], test_name: str = None) -> Dict[str, Any]:
    """Main function to analyze user performance"""
    return await ai_analyzer.analyze_performance(user_data, test_name)

async def get_question_hint(question_data: Dict[str, Any]) -> str:
    """Get AI-generated hint for a question"""
    return await ai_analyzer.generate_question_hints(question_data)

def is_ai_available() -> bool:
    """Check if AI features are available"""
    return ai_analyzer.is_available()

# if __name__ == "__main__":
#     # Test the AI analysis system
#     test_data = {
#         "test_name": "CAT-2024-Slot-1",
#         "section_scores": {"VARC": 45, "DILR": 30, "QA": 42},
#         "answers": {"VARC_1": {"correct": True}, "VARC_2": {"correct": False}},
#         "time_analysis": {"total_time": "01:45:30", "avg_per_question": "02:30"},
#         "bookmarks": ["VARC_5", "QA_10"],
#         "flags": {"DILR_3": "red", "QA_15": "yellow"}
#     }
    
#     # Run async test
#     async def test_analysis():
#         result = await analyze_user_performance(test_data)
#         print("Analysis Result:")
#         print(result["analysis"])
        
#     asyncio.run(test_analysis())
