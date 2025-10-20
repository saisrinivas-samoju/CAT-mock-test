#!/usr/bin/env python3
"""
Test script for Vercel deployment
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

def test_imports():
    """Test that all required modules can be imported"""
    try:
        import vercel_app
        print("✅ vercel_app imported successfully")
        
        from vercel_app import app
        print("✅ FastAPI app imported successfully")
        
        # Test basic functionality
        from vercel_app import load_test_data, load_users
        print("✅ Helper functions imported successfully")
        
        return True
    except Exception as e:
        print(f"❌ Import error: {e}")
        return False

def test_data_loading():
    """Test that data files can be loaded"""
    try:
        from vercel_app import load_test_data, load_users
        
        # Test loading test data
        test_data = load_test_data()
        print(f"✅ Test data loaded: {len(test_data)} tests found")
        
        # Test loading users
        users = load_users()
        print(f"✅ Users data loaded: {len(users)} users found")
        
        return True
    except Exception as e:
        print(f"❌ Data loading error: {e}")
        return False

def test_app_routes():
    """Test that the app has the required routes"""
    try:
        from vercel_app import app
        
        routes = [route.path for route in app.routes]
        required_routes = [
            "/",
            "/api/signup",
            "/api/login", 
            "/api/tests",
            "/api/start-test",
            "/api/test-data/{test_name}",
            "/api/session/{session_id}",
            "/api/submit-answer",
            "/api/bookmark",
            "/api/flag"
        ]
        
        missing_routes = []
        for route in required_routes:
            if not any(route in r for r in routes):
                missing_routes.append(route)
        
        if missing_routes:
            print(f"❌ Missing routes: {missing_routes}")
            return False
        else:
            print("✅ All required routes found")
            return True
            
    except Exception as e:
        print(f"❌ Route testing error: {e}")
        return False

if __name__ == "__main__":
    print("🧪 Testing Vercel deployment setup...")
    print("=" * 50)
    
    tests = [
        ("Import Test", test_imports),
        ("Data Loading Test", test_data_loading),
        ("Routes Test", test_app_routes)
    ]
    
    passed = 0
    total = len(tests)
    
    for test_name, test_func in tests:
        print(f"\n🔍 {test_name}:")
        if test_func():
            passed += 1
        else:
            print(f"❌ {test_name} failed")
    
    print("\n" + "=" * 50)
    print(f"📊 Test Results: {passed}/{total} tests passed")
    
    if passed == total:
        print("🎉 All tests passed! Ready for Vercel deployment.")
        sys.exit(0)
    else:
        print("⚠️  Some tests failed. Please fix issues before deploying.")
        sys.exit(1)
