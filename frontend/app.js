class CATMockTestApp {
    constructor() {
        this.currentUser = null;
        this.currentSession = null;
        this.testData = null;
        this.currentSection = 'VARC';
        this.currentQuestionIndex = 0;
        this.answers = {};
        this.bookmarks = [];
        this.flags = {};
        this.timeRemaining = 7200; // 2 hours in seconds
        this.timerInterval = null;
        this.autoSaveInterval = null;
        this.questionStartTime = null;
        this.isSubmitting = false; // Flag to prevent duplicate submissions
        this.sectionQuestions = {
            'VARC': [],
            'DILR': [],
            'QA': []
        };
        
        // Initialize dark mode immediately to prevent flash
        this.initDarkMode();
        
        this.init();
    }

    async init() {
        
        // Browser compatibility checks
        this.checkBrowserCompatibility();
        
        // Check if user is already logged in
        const savedUser = localStorage.getItem('catUser');
        if (savedUser) {
            try {
                this.currentUser = JSON.parse(savedUser);
                
                // Validate parsed user object
                if (!this.currentUser || !this.currentUser.username) {
                    console.warn('Invalid user data in localStorage, clearing...');
                    localStorage.removeItem('catUser');
                    this.currentUser = null;
                    this.showPage('authPage');
                    this.setupEventListeners();
                    return;
                }
                
                // Check for page refresh recovery first
                const recovered = await this.checkForPageRefreshRecovery();
                
                if (!recovered) {
                    this.showPage('dashboardPage');
                    await this.loadDashboard();
                }
            } catch (error) {
                console.error('Error parsing user data from localStorage:', error);
                console.warn('Clearing corrupted localStorage data...');
                // Clear corrupted data
                localStorage.removeItem('catUser');
                this.currentUser = null;
                this.showPage('authPage');
            }
        } else {
            this.showPage('authPage');
        }
        
        this.setupEventListeners();
    }

    async checkForPageRefreshRecovery() {
        // Check if user has an active non-paused session that might have been lost on refresh
        if (!this.currentUser) return false;
        
        try {
            const response = await fetch(`/api/active-session/${this.currentUser.username}`);
            if (response.ok) {
                const sessionData = await this.safeJsonParse(response);
                if (sessionData.session_id && !sessionData.is_paused) {
                    const answeredCount = Object.keys(sessionData.answers || {}).length;
                    const timeRemainingMins = Math.floor(sessionData.time_remaining / 60);
                    
                    // Only offer recovery if user has significant progress
                    if (answeredCount > 0 || timeRemainingMins < 115) {
                        const recover = confirm(
                            `🔄 Test Session Recovery Available!\n\n` +
                            `Your test session was interrupted but your progress is saved:\n\n` +
                            `📝 Test: ${sessionData.test_name}\n` +
                            `⏱️ Time remaining: ${timeRemainingMins} minutes\n` +
                            `📊 Questions answered: ${answeredCount}\n` +
                            `📍 Current section: ${sessionData.section}\n\n` +
                            `Would you like to continue from where you left off?`
                        );
                        
                        if (recover) {
                            await this.resumeInterruptedSession(sessionData);
                            return true; // Session recovered
                        } else {
                            // User declined recovery, clean up the session
                            await this.cleanupSession(sessionData.session_id);
                        }
                    }
                }
            }
        } catch (error) {
            console.log('No active session found for recovery:', error);
        }
        
        return false; // No recovery needed or declined
    }

    async resumeInterruptedSession(sessionData) {
        try {
            // Clear any existing intervals first
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }
            if (this.autoSaveInterval) {
                clearInterval(this.autoSaveInterval);
                this.autoSaveInterval = null;
            }
            
            this.currentSession = sessionData.session_id;
            
            // Load test data
            const testResponse = await fetch(`/api/test-data/${sessionData.test_name}`);
            if (!testResponse.ok) {
                throw new Error('Failed to load test data');
            }
            
            let testData;
            try {
                testData = await this.safeJsonParse(testResponse);
            } catch (parseError) {
                console.error('Error parsing test data response:', parseError);
                throw new Error('Failed to parse test data response');
            }
            
            // Store raw test data and properly flatten questions
            this.testData = testData;
            this.sectionQuestions = {
                'VARC': this.flattenQuestions(this.testData.VARC, 'VARC'),
                'DILR': this.flattenQuestions(this.testData.DILR, 'DILR'),
                'QA': this.flattenQuestions(this.testData.QA, 'QA')
            };
            
            this.answers = {};
            
            // Convert answers from backend format to frontend format
            Object.keys(sessionData.answers || {}).forEach(questionId => {
                const answerData = sessionData.answers[questionId];
                if (answerData && answerData.answer && answerData.answer.trim() !== '') {
                    // Normalize answer - preserve numeric format, lowercase alphabetic
                    let answer = answerData.answer.trim();
                    
                    // Handle old sessions where answer might be stored as HTML (e.g., "<p>a) text...</p>")
                    // Check if answer contains HTML tags - if so, extract just the option letter/number
                    if (answer.includes('<') && answer.includes('>')) {
                        // This is HTML format - need to find the question type to extract properly
                        // Try to find question data to get question type
                        let questionType = 'Multiple Choice Question'; // Default
                        for (const [sectionName, questions] of Object.entries(this.sectionQuestions)) {
                            const question = questions.find(q => q.id === questionId);
                            if (question) {
                                questionType = question.question_type || questionType;
                                break;
                            }
                        }
                        // Extract answer from HTML using the helper function
                        answer = this.extractAnswerFromHtml(answer, questionType);
                    }
                    
                    // Now normalize the extracted answer
                    if (/^\d+$/.test(answer)) {
                        // Numeric option: keep as string
                        this.answers[questionId] = answer;
                    } else if (answer.length === 1 && /[a-zA-Z]/.test(answer)) {
                        // Single letter option: lowercase
                        this.answers[questionId] = answer.toLowerCase();
                    } else {
                        // TITA or other format: keep as-is
                        this.answers[questionId] = answer;
                    }
                }
            });
            
            this.bookmarks = sessionData.bookmarks || [];
            this.flags = sessionData.flags || {};
            this.currentSection = sessionData.section || 'VARC';
            this.currentQuestionIndex = sessionData.question_index || 0;
            // Ensure time_remaining is never negative
            this.timeRemaining = Math.max(0, sessionData.time_remaining || 7200);
            
            // If time has expired, auto-submit instead of showing negative time
            if (this.timeRemaining <= 0) {
                this.showToast('Test time has expired. Submitting automatically...', 'warning');
                setTimeout(() => {
                    if (!this.isSubmitting) {
                        this.submitTest();
                    }
                }, 1000);
                return;
            }
            
            // Set test name for display
            const testNameEl = document.getElementById('testName');
            if (testNameEl) {
                testNameEl.textContent = sessionData.test_name;
            }
            
            // Switch to test page
            this.showPage('testPage');
            
            // Reset all button states to normal
            this.resetButtonStates();
            
            // Initialize test interface with recovered data
            this.generateQuestionPalette();
            this.switchSection(this.currentSection);
            this.displayQuestion();
            this.startTimer();
            this.startAutoSave();
            
            this.showToast('🎉 Test session recovered successfully! Continue from where you left off.', 'success');
            
        } catch (error) {
            console.error('Error resuming session:', error);
            this.showToast('❌ Failed to recover test session. Starting fresh.', 'error');
            await this.cleanupSession(sessionData.session_id);
        }
    }

    async cleanupSession(sessionId) {
        try {
            await fetch('/api/cleanup-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: sessionId })
            });
        } catch (error) {
            console.error('Error cleaning up session:', error);
        }
    }

    resetButtonStates() {
        // Reset submit button to normal state
        // Also reset the isSubmitting flag to prevent stuck state
        this.isSubmitting = false;
        
        const submitButtons = document.querySelectorAll('[onclick*="submitTest"]');
        submitButtons.forEach(btn => {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit';
            }
        });
        
        // Reset other control buttons if needed
        const saveButtons = document.querySelectorAll('[onclick*="saveTest"]');
        saveButtons.forEach(btn => {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-save"></i> Save';
            }
        });
        
        const pauseButtons = document.querySelectorAll('[onclick*="pauseTest"]');
        pauseButtons.forEach(btn => {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-pause"></i> Pause';
        });
    }

    setupEventListeners() {
        // Global click handler for flag menu
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.flag-dropdown')) {
                document.getElementById('flagMenu')?.classList.remove('active');
            }
        });

        // Auto-save on page unload
        window.addEventListener('beforeunload', () => {
            // Clear intervals to prevent memory leaks
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }
            if (this.autoSaveInterval) {
                clearInterval(this.autoSaveInterval);
                this.autoSaveInterval = null;
            }
            
            // Try to save session (but don't block unload)
            if (this.currentSession) {
                // Use sendBeacon for reliable saving on page unload
                try {
                    navigator.sendBeacon('/api/save-session', JSON.stringify({
                        session_id: this.currentSession
                    }));
                } catch (e) {
                    // Fallback: synchronous fetch (may be cancelled)
                    fetch('/api/save-session', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ session_id: this.currentSession }),
                        keepalive: true
                    }).catch(() => {}); // Ignore errors on unload
                }
            }
        });
        
        // Global error handler for unhandled errors
        window.addEventListener('error', (event) => {
            // Enhanced error logging to help debug
            const errorDetails = {
                message: event.message,
                filename: event.filename,
                lineno: event.lineno,
                colno: event.colno,
                error: event.error,
                stack: event.error?.stack,
                timestamp: new Date().toISOString(),
                userAgent: navigator.userAgent,
                currentSession: this.currentSession,
                currentUser: this.currentUser?.username
            };
            console.error('Global JavaScript error:', errorDetails);
            
            // Log to console with full details for debugging
            console.group('🚨 Unexpected Error Details');
            console.error('Error:', event.error);
            console.error('Message:', event.message);
            console.error('File:', event.filename, 'Line:', event.lineno);
            console.error('Stack:', event.error?.stack);
            console.error('Session:', this.currentSession);
            console.groupEnd();
            
            // Try to save session if exists (with better error handling)
            if (this.currentSession) {
                this.saveSession().catch((saveError) => {
                    console.error('Failed to save session during error recovery:', saveError);
                });
            }
            // Show user-friendly error message
            this.showToast('An unexpected error occurred. Your progress has been saved.', 'error');
        });
        
        // Handle unhandled promise rejections
        window.addEventListener('unhandledrejection', (event) => {
            // Enhanced logging for promise rejections
            const errorDetails = {
                reason: event.reason,
                promise: event.promise,
                timestamp: new Date().toISOString(),
                currentSession: this.currentSession,
                currentUser: this.currentUser?.username
            };
            console.error('Unhandled promise rejection:', errorDetails);
            
            // Log full details
            console.group('🚨 Unhandled Promise Rejection');
            console.error('Reason:', event.reason);
            console.error('Type:', typeof event.reason);
            console.error('Stack:', event.reason?.stack || 'No stack trace');
            console.error('Session:', this.currentSession);
            console.groupEnd();
            
            // Try to save session if exists
            if (this.currentSession) {
                this.saveSession().catch((saveError) => {
                    console.error('Failed to save session during promise rejection recovery:', saveError);
                });
            }
            // Show user-friendly error message
            this.showToast('An error occurred. Your progress has been saved.', 'error');
            // Prevent default browser error handling
            event.preventDefault();
        });
    }
    
    checkBrowserCompatibility() {
        /**Check browser compatibility and provide fallbacks or warnings*/
        const issues = [];
        
        // Check localStorage support
        try {
            const testKey = '__localStorage_test__';
            localStorage.setItem(testKey, 'test');
            localStorage.removeItem(testKey);
        } catch (e) {
            issues.push('localStorage is not available. Your progress may not be saved.');
            console.warn('localStorage not available:', e);
        }
        
        // Check fetch API support
        if (!window.fetch) {
            issues.push('Fetch API is not available. Using XMLHttpRequest fallback.');
            // Polyfill would be needed for older browsers
            if (!window.XMLHttpRequest) {
                issues.push('No HTTP request method available. App may not work.');
            }
        }
        
        // Check for required DOM methods
        if (!document.querySelector || !document.getElementById) {
            issues.push('Required DOM methods not available. App may not work.');
        }
        
        // Check for Promise support
        if (typeof Promise === 'undefined') {
            issues.push('Promises are not supported. App may not work correctly.');
        }
        
        // Check for async/await support (ES2017) - without using eval()
        // Use feature detection instead of eval for security
        try {
            // Test if async functions can be created by checking constructor
            const asyncFunctionConstructor = (async function() {}).constructor;
            if (!asyncFunctionConstructor) {
                issues.push('Async/await not supported. Some features may not work.');
            }
        } catch (e) {
            issues.push('Async/await not supported. Some features may not work.');
        }
        
        // Show warnings if any issues found
        if (issues.length > 0) {
            console.warn('Browser compatibility issues detected:', issues);
            
            // Only show critical warnings to user
            const criticalIssues = issues.filter(issue => 
                issue.includes('may not work') || issue.includes('not available')
            );
            
            if (criticalIssues.length > 0) {
                this.showToast(
                    `Browser compatibility warning: ${criticalIssues[0]}`,
                    'warning'
                );
            }
        }
    }

    // Utility Functions
    showPage(pageId) {
        document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
        document.getElementById(pageId).classList.add('active');
        
        // Update user greeting when showing dashboard
        if (pageId === 'dashboardPage') {
            this.updateUserGreeting();
        }
    }

    showLoading() {
        document.getElementById('loadingOverlay').classList.add('active');
    }

    hideLoading() {
        document.getElementById('loadingOverlay').classList.remove('active');
    }

    showToast(message, type = 'info', persistent = false) {
        const toastContainer = document.getElementById('toastContainer');
        if (!toastContainer) {
            console.error('Toast container not found');
            return;
        }
        
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        
        const icon = {
            'success': 'fa-check-circle',
            'error': 'fa-exclamation-circle',
            'warning': 'fa-exclamation-triangle',
            'info': 'fa-info-circle'
        }[type];
        
        // For persistent errors, add a close button and make it stay longer
        const closeBtn = persistent ? '<button class="toast-close" onclick="this.parentElement.remove()" title="Close">&times;</button>' : '';
        
        toast.innerHTML = `
            <i class="fas ${icon}"></i>
            <span>${message}</span>
            ${closeBtn}
        `;
        
        toastContainer.appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 100);
        
        // For errors, make them persistent (user must close) or show longer
        const duration = persistent ? 0 : (type === 'error' ? 10000 : 3000); // 10 seconds for errors
        
        if (duration > 0) {
            setTimeout(() => {
                if (toast.parentElement) {
                    toast.classList.remove('show');
                    setTimeout(() => {
                        if (toast.parentElement) {
                            toastContainer.removeChild(toast);
                        }
                    }, 300);
                }
            }, duration);
        }
        
        // Also log to persistent error area for critical errors
        if (type === 'error' && persistent) {
            this.showPersistentError(message);
        }
    }
    
    showPersistentError(errorMessage) {
        // Create or update persistent error display
        let errorDisplay = document.getElementById('persistentErrorDisplay');
        if (!errorDisplay) {
            errorDisplay = document.createElement('div');
            errorDisplay.id = 'persistentErrorDisplay';
            errorDisplay.className = 'persistent-error-display';
            errorDisplay.innerHTML = `
                <div class="persistent-error-content">
                    <div class="persistent-error-header">
                        <i class="fas fa-exclamation-triangle"></i>
                        <strong>Submission Error</strong>
                        <button onclick="document.getElementById('persistentErrorDisplay').remove()" class="persistent-error-close">&times;</button>
                    </div>
                    <div class="persistent-error-message"></div>
                    <div class="persistent-error-actions">
                        <button onclick="app.retrySubmission()" class="action-btn primary">Retry Submission</button>
                        <button onclick="document.getElementById('persistentErrorDisplay').remove()" class="action-btn">Dismiss</button>
                    </div>
                </div>
            `;
            document.body.appendChild(errorDisplay);
        }
        
        const messageEl = errorDisplay.querySelector('.persistent-error-message');
        if (messageEl) {
            messageEl.textContent = errorMessage;
        }
        
        // Make it visible
        errorDisplay.style.display = 'block';
    }
    
    async retrySubmission() {
        // Remove persistent error display
        const errorDisplay = document.getElementById('persistentErrorDisplay');
        if (errorDisplay) {
            errorDisplay.remove();
        }
        
        // Retry submission
        await this.submitTest();
    }

    initDarkMode() {
        // Check for saved dark mode preference
        const isDarkMode = localStorage.getItem('darkMode') === 'true';
        if (isDarkMode) {
            document.documentElement.classList.add('dark-mode');
            document.body.classList.add('dark-mode');
            this.updateThemeIcon(true);
        } else {
            this.updateThemeIcon(false);
        }
    }

    toggleDarkMode() {
        const isDarkMode = document.body.classList.toggle('dark-mode');
        document.documentElement.classList.toggle('dark-mode', isDarkMode);
        localStorage.setItem('darkMode', isDarkMode.toString());
        this.updateThemeIcon(isDarkMode);
    }

    updateThemeIcon(isDarkMode) {
        const themeIcons = document.querySelectorAll('.theme-icon');
        themeIcons.forEach(icon => {
            if (isDarkMode) {
                icon.classList.remove('fa-moon');
                icon.classList.add('fa-sun');
            } else {
                icon.classList.remove('fa-sun');
                icon.classList.add('fa-moon');
            }
        });
    }

    formatTime(seconds) {
        // Ensure seconds is never negative
        const safeSeconds = Math.max(0, Math.floor(seconds || 0));
        const hours = Math.floor(safeSeconds / 3600);
        const minutes = Math.floor((safeSeconds % 3600) / 60);
        const secs = safeSeconds % 60;
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    // Authentication Functions
    async handleSignup(event) {
        event.preventDefault();
        const name = document.getElementById('signupName').value.trim();
        const username = document.getElementById('signupUsername').value.trim();
        
        if (!name || !username) {
            this.showToast('Please fill in all fields', 'error');
            return;
        }

        this.showLoading();
        
        try {
            const response = await fetch('/api/signup', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ name, username })
            });

            let data;
            try {
                const contentType = response.headers.get('content-type');
                if (contentType && contentType.includes('application/json')) {
                    data = await response.json();
                } else {
                    const text = await response.text();
                    throw new Error(text || `Server returned ${response.status}: ${response.statusText}`);
                }
            } catch (parseError) {
                console.error('Error parsing signup response:', parseError);
                this.showToast('Error: Invalid response from server', 'error');
                this.hideLoading();
                return;
            }

            if (response.ok) {
                this.currentUser = { username: data.username, name: data.name };
                this.showToast(`Welcome, ${data.name}! Account created successfully!`, 'success');
                try {
                    localStorage.setItem('catUser', JSON.stringify(this.currentUser));
                } catch (error) {
                    if (error.name === 'QuotaExceededError' || error.code === 22) {
                        console.warn('localStorage quota exceeded. Clearing old data...');
                        // Try to clear and retry once
                        try {
                            localStorage.clear();
                            localStorage.setItem('catUser', JSON.stringify(this.currentUser));
                            console.log('Successfully saved user data after clearing localStorage');
                        } catch (retryError) {
                            console.error('Failed to save user data even after clearing localStorage:', retryError);
                            this.showToast('Warning: Could not save login session. You may need to login again after refresh.', 'warning');
                        }
                    } else {
                        console.error('Error saving to localStorage:', error);
                        this.showToast('Warning: Could not save login session.', 'warning');
                    }
                }
                // Update greeting before showing dashboard
                this.updateUserGreeting();
                this.showPage('dashboardPage');
                await this.loadDashboard();
            } else {
                this.showToast(data.detail || 'Signup failed', 'error');
            }
        } catch (error) {
            console.error('Signup error:', error);
            this.showToast('Network error. Please try again.', 'error');
        } finally {
            this.hideLoading();
        }
    }

    async handleLogin(event) {
        event.preventDefault();
        const username = document.getElementById('loginUsername').value.trim();
        
        if (!username) {
            this.showToast('Please enter your username', 'error');
            return;
        }

        this.showLoading();
        
        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ username })
            });

            let data;
            try {
                data = await this.safeJsonParse(response);
            } catch (parseError) {
                console.error('Error parsing login response:', parseError);
                this.showToast('Error: Invalid response from server', 'error');
                this.hideLoading();
                return;
            }

            if (response.ok) {
                this.currentUser = { username: data.username, name: data.name };
                this.showToast(`Welcome back, ${data.name}!`, 'success');
                try {
                    localStorage.setItem('catUser', JSON.stringify(this.currentUser));
                } catch (error) {
                    if (error.name === 'QuotaExceededError' || error.code === 22) {
                        console.warn('localStorage quota exceeded. Clearing old data...');
                        // Try to clear and retry once
                        try {
                            localStorage.clear();
                            localStorage.setItem('catUser', JSON.stringify(this.currentUser));
                            console.log('Successfully saved user data after clearing localStorage');
                        } catch (retryError) {
                            console.error('Failed to save user data even after clearing localStorage:', retryError);
                            this.showToast('Warning: Could not save login session. You may need to login again after refresh.', 'warning');
                        }
                    } else {
                        console.error('Error saving to localStorage:', error);
                        this.showToast('Warning: Could not save login session.', 'warning');
                    }
                }
                // Update greeting before showing dashboard
                this.updateUserGreeting();
                this.showPage('dashboardPage');
                await this.loadDashboard();
            } else {
                this.showToast(data.detail || 'Login failed', 'error');
            }
        } catch (error) {
            console.error('Login error:', error);
            this.showToast('Network error. Please try again.', 'error');
        } finally {
            this.hideLoading();
        }
    }

    async logout() {
        // Clear intervals to prevent memory leaks
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        if (this.autoSaveInterval) {
            clearInterval(this.autoSaveInterval);
            this.autoSaveInterval = null;
        }
        
        // Clean up session if exists
        if (this.currentSession) {
            try {
                await fetch('/api/cleanup-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_id: this.currentSession })
                }).catch(() => {}); // Ignore errors on logout
            } catch (e) {
                // Ignore cleanup errors
            }
            this.currentSession = null;
        }
        
        // Reset submission flag
        this.isSubmitting = false;
        
        // Clear user data
        localStorage.removeItem('catUser');
        this.currentUser = null;
        
        this.showPage('authPage');
        this.showToast('Logged out successfully', 'info');
    }

    // Update user greeting
    updateUserGreeting() {
        const greetingElement = document.getElementById('userGreeting');
        if (greetingElement && this.currentUser && this.currentUser.name) {
            greetingElement.textContent = `Welcome, ${this.currentUser.name}!`;
        } else if (greetingElement) {
            greetingElement.textContent = 'Welcome!';
        }
    }

    // Dashboard Functions
    async loadDashboard() {
        // Update greeting first
        this.updateUserGreeting();
        
        await this.loadAvailableTests();
        await this.loadUserProgress();
        await this.checkForPausedTests();
    }

    async checkForPausedTests() {
        try {
            const response = await fetch(`/api/paused-tests/${this.currentUser.username}`);
            
            if (response.ok) {
                const pausedTests = await this.safeJsonParse(response);
                
                if (pausedTests.length > 0) {
                    this.displayPausedTests(pausedTests);
                }
            }
        } catch (error) {
            console.error('Error checking for paused tests:', error);
        }
    }

    displayPausedTests(pausedTests) {
        const testsGrid = document.getElementById('testsList');
        
        if (!testsGrid) {
            console.error('testsList element not found');
            return;
        }
        
        // Remove any existing paused tests section first
        const existingPausedSection = document.querySelector('.paused-tests-section');
        if (existingPausedSection) {
            existingPausedSection.remove();
        }
        
        // Add paused tests section at the top
        const pausedSection = `
            <div class="paused-tests-section" style="grid-column: 1 / -1; margin-bottom: 2rem;">
                <h3 style="color: var(--warning-color); margin-bottom: 1rem;">
                    <i class="fas fa-pause-circle"></i> Resume Paused Tests
                </h3>
                <div class="paused-tests-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem;">
                    ${pausedTests.map(test => `
                        <div class="test-card paused-test" style="border-left: 4px solid var(--warning-color);">
                            <h4><i class="fas fa-clock"></i> ${test.test_name}</h4>
                            <div class="paused-info">
                                <p><strong>Section:</strong> ${test.section}</p>
                                <p><strong>Time Remaining:</strong> ${this.formatTime(test.time_remaining)}</p>
                                <p><strong>Paused:</strong> ${new Date(test.paused_at).toLocaleString()}</p>
                                <p><strong>Progress:</strong> ${test.answered_questions}/${test.total_questions} questions</p>
                            </div>
                            <button class="start-btn resume-btn" onclick="app.resumePausedTest('${test.session_id}')" 
                                    style="background: var(--warning-color);">
                                <i class="fas fa-play"></i> Resume Test
                            </button>
                        </div>
                    `).join('')}
                </div>
                <hr style="margin: 2rem 0; border: 1px solid var(--border-color);">
            </div>
        `;
        
        testsGrid.innerHTML = pausedSection + testsGrid.innerHTML;
    }

    async loadUserProgress() {
        try {
            // Try to get user progress data
            const response = await fetch(`/api/user-stats/${this.currentUser.username}`);
            
            if (response.ok) {
                const stats = await this.safeJsonParse(response);
                this.updateProgressDisplay(stats);
            } else {
                // No progress data yet, show defaults
                this.updateProgressDisplay({
                    total_time: 0,
                    tests_completed: 0,
                    average_score: 0,
                    total_attempts: 0
                });
            }
        } catch (error) {
            console.log('No progress data available yet');
            // Show default values
            this.updateProgressDisplay({
                total_time: 0,
                tests_completed: 0,
                average_score: 0,
                total_attempts: 0
            });
        }
    }

    async showCompletedTests() {
        try {
            this.showLoading();
            const response = await fetch(`/api/completed-tests/${this.currentUser.username}`);
            
            if (response.ok) {
                const completedTests = await this.safeJsonParse(response);
                
                if (completedTests.length === 0) {
                    this.showToast('No completed tests found.', 'info');
                    return;
                }
                
                // Create and show modal with completed tests
                this.displayCompletedTestsModal(completedTests);
            } else {
                this.showToast('Failed to load completed tests.', 'error');
            }
        } catch (error) {
            console.error('Error loading completed tests:', error);
            this.showToast('Error loading completed tests.', 'error');
        } finally {
            this.hideLoading();
        }
    }

    displayCompletedTestsModal(completedTests) {
        // Create modal HTML
        const modalHTML = `
            <div id="completedTestsModal" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 10000; display: flex; align-items: center; justify-content: center;">
                <div style="background: var(--surface-color); border-radius: 12px; padding: 2rem; max-width: 800px; width: 90%; max-height: 80vh; overflow-y: auto; box-shadow: 0 10px 30px rgba(0,0,0,0.3);">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
                        <h2 style="margin: 0; color: var(--text-primary);"><i class="fas fa-check-circle"></i> Completed Tests</h2>
                        <button onclick="document.getElementById('completedTestsModal').remove()" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-secondary);">&times;</button>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 1rem;">
                        ${completedTests.map(test => `
                            <div style="padding: 1.5rem; background: var(--background-color); border-radius: 8px; border: 2px solid var(--border-color);">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                                    <h3 style="margin: 0; color: var(--text-primary);">${this.escapeHtml(test.test_name || 'Unknown Test')}</h3>
                                    <span style="color: var(--text-secondary); font-size: 0.9rem;">${this.escapeHtml(test.date || '')}</span>
                                </div>
                                <div style="display: flex; gap: 2rem; margin-top: 1rem;">
                                    <div>
                                        <span style="color: var(--text-secondary);">Score:</span>
                                        <span style="color: var(--primary-color); font-weight: bold; margin-left: 0.5rem;">${test.total_score || 0}/198</span>
                                    </div>
                                    <div>
                                        <span style="color: var(--text-secondary);">Accuracy:</span>
                                        <span style="color: var(--success-color); font-weight: bold; margin-left: 0.5rem;">${test.accuracy || 0}%</span>
                                    </div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                    <div style="margin-top: 1.5rem; text-align: right;">
                        <button onclick="document.getElementById('completedTestsModal').remove()" style="padding: 0.75rem 1.5rem; background: var(--primary-color); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 1rem;">Close</button>
                    </div>
                </div>
            </div>
        `;
        
        // Remove existing modal if any
        const existingModal = document.getElementById('completedTestsModal');
        if (existingModal) {
            existingModal.remove();
        }
        
        // Add modal to body
        document.body.insertAdjacentHTML('beforeend', modalHTML);
    }

    updateProgressDisplay(stats) {
        // Update total time - with null check
        const totalTimeEl = document.getElementById('totalTime');
        if (totalTimeEl) {
            const hours = Math.floor(stats.total_time / 3600);
            const minutes = Math.floor((stats.total_time % 3600) / 60);
            totalTimeEl.textContent = `${hours}h ${minutes}m`;
        }
        
        // Update tests completed - make it clickable
        const testsCompletedElement = document.getElementById('testsCompleted');
        if (testsCompletedElement) {
            testsCompletedElement.textContent = stats.tests_completed || stats.total_attempts || 0;
            // Make it clickable to show completed tests
            testsCompletedElement.style.cursor = 'pointer';
            testsCompletedElement.style.color = 'var(--primary-color)';
            testsCompletedElement.style.textDecoration = 'underline';
            testsCompletedElement.onclick = () => this.showCompletedTests();
        }
        
        // Update average score - with null check
        const avgScoreEl = document.getElementById('avgScore');
        if (avgScoreEl) {
            const avgScore = stats.average_score || 0;
            avgScoreEl.textContent = `${Math.round(avgScore)}%`;
        }
    }

    async loadAvailableTests() {
        try {
            const response = await fetch('/api/tests');
            const tests = await this.safeJsonParse(response);
            
            const testsGrid = document.getElementById('testsList');
            testsGrid.innerHTML = tests.map(test => `
                <div class="test-card" onclick="app.startTest('${test.name}')">
                    <h3><i class="fas fa-file-alt"></i> ${test.name}</h3>
                    <div class="test-sections">
                        <div class="section-info">
                            <span class="section-name">VARC</span>
                            <span class="section-count">${test.sections.VARC} questions</span>
                        </div>
                        <div class="section-info">
                            <span class="section-name">DILR</span>
                            <span class="section-count">${test.sections.DILR} questions</span>
                        </div>
                        <div class="section-info">
                            <span class="section-name">QA</span>
                            <span class="section-count">${test.sections.QA} questions</span>
                        </div>
                    </div>
                    <div class="test-meta">
                        <span><i class="fas fa-question-circle"></i> ${test.total_questions} questions</span>
                        <span><i class="fas fa-clock"></i> 120 minutes</span>
                    </div>
                    <button class="start-btn">
                        <i class="fas fa-play"></i> Start Test
                    </button>
                </div>
            `).join('');
        } catch (error) {
            console.error('Error loading tests:', error);
            this.showToast('Failed to load tests', 'error');
        }
    }

    // Test Functions
    async startTest(testName) {
        // Check if user is logged in
        if (!this.currentUser || !this.currentUser.username) {
            this.showToast('Please login first to start the test', 'error');
            this.showPage('authPage');
            return;
        }

        if (!confirm('Are you ready to start the test? Once started, the timer will begin.')) {
            return;
        }

        this.showLoading();
        
        try {
            console.log('Starting test for user:', this.currentUser.username, 'Test:', testName);
            
            // Start test session
            const sessionResponse = await fetch('/api/start-test', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    username: this.currentUser.username,
                    test_name: testName
                })
            });

            if (!sessionResponse.ok) {
                let errorData;
                try {
                    errorData = await this.safeJsonParse(sessionResponse);
                } catch {
                    errorData = { detail: 'Failed to start test session' };
                }
                throw new Error(errorData.detail || 'Failed to start test session');
            }
            
            const sessionData = await this.safeJsonParse(sessionResponse);
            this.currentSession = sessionData.session_id;

            // Load test data
            const testResponse = await fetch(`/api/test-data/${testName}`);
            if (!testResponse.ok) {
                let errorData;
                try {
                    errorData = await this.safeJsonParse(testResponse);
                } catch {
                    errorData = { detail: 'Failed to load test data' };
                }
                throw new Error(errorData.detail || 'Failed to load test data');
            }
            this.testData = await this.safeJsonParse(testResponse);
            
            // Initialize test state
            this.initializeTest(testName);
            
            // Show test interface
            this.showPage('testPage');
            this.startTimer();
            this.startAutoSave();
            
            this.showToast('Test started successfully!', 'success');
        } catch (error) {
            console.error('Error starting test:', error);
            this.showToast(`Failed to start test: ${error.message}`, 'error');
        } finally {
            this.hideLoading();
        }
    }

    initializeTest(testName) {
        console.log('Initializing test:', testName);
        
        // Reset all button states and flags before starting new test
        this.resetButtonStates();
        this.isSubmitting = false;
        
        // Validate testData exists
        if (!this.testData) {
            console.error('Test data not loaded');
            this.showToast('Error: Test data not loaded. Please try again.', 'error');
            return;
        }
        
        // Update test name display (with null check)
        const testNameElement = document.getElementById('testName');
        if (testNameElement) {
            testNameElement.textContent = testName || 'CAT Mock Test';
        }
        
        // Reset all test state
        this.currentSection = 'VARC';
        this.currentQuestionIndex = 0;
        this.answers = {};
        this.bookmarks = [];
        this.flags = {};
        this.timeRemaining = 7200;
        this.isSubmitting = false; // Reset submission flag
        
        // Flatten questions for easy navigation (with validation)
        try {
            this.sectionQuestions = {
                'VARC': this.flattenQuestions(this.testData.VARC || [], 'VARC'),
                'DILR': this.flattenQuestions(this.testData.DILR || [], 'DILR'),
                'QA': this.flattenQuestions(this.testData.QA || [], 'QA')
            };
            
            // Validate that we have questions
            const totalQuestions = this.sectionQuestions.VARC.length + 
                                  this.sectionQuestions.DILR.length + 
                                  this.sectionQuestions.QA.length;
            
            if (totalQuestions === 0) {
                throw new Error('No questions found in test data');
            }
            
            console.log('Section questions:', {
                VARC: this.sectionQuestions.VARC.length,
                DILR: this.sectionQuestions.DILR.length,
                QA: this.sectionQuestions.QA.length,
                total: totalQuestions
            });
        } catch (error) {
            console.error('Error initializing test:', error);
            this.showToast(`Error loading test: ${error.message}`, 'error');
            return;
        }
        
        // Ensure VARC tab is selected initially
        document.querySelectorAll('.section-tab').forEach(tab => {
            tab.classList.remove('active');
            if (tab.textContent.trim() === 'VARC') {
                tab.classList.add('active');
            }
        });
        
        this.generateQuestionPalette();
        this.displayQuestion();
    }

    flattenQuestions(sectionData, sectionName) {
        const questions = [];
        let questionCounter = 1; // Fallback counter for question numbering
        
        // Validate sectionData is array
        if (!sectionData || !Array.isArray(sectionData)) {
            console.error(`Invalid sectionData for ${sectionName}:`, sectionData);
            return questions; // Return empty array
        }
        
        sectionData.forEach((questionObj, objIndex) => {
            // Validate questionObj structure
            if (!questionObj || typeof questionObj !== 'object') {
                console.warn(`Invalid questionObj at index ${objIndex} in ${sectionName}`);
                return; // Skip this object
            }
            
            // Validate qa_list exists and is array
            const qa_list = questionObj.qa_list;
            if (!qa_list || !Array.isArray(qa_list) || qa_list.length === 0) {
                console.warn(`No qa_list found in questionObj at index ${objIndex} in ${sectionName}`);
                return; // Skip if no questions
            }
            
            qa_list.forEach((qa, qaIndex) => {
                // Validate qa is an object
                if (!qa || typeof qa !== 'object') {
                    console.warn(`Invalid qa at index ${qaIndex} in ${sectionName} questionObj ${objIndex}`);
                    return; // Skip this qa
                }
                // Get question number with fallback
                let questionNum = Array.isArray(qa.question_num) ? qa.question_num[0] : qa.question_num;
                
                // If question_num is undefined, null, or invalid, use fallback counter
                if (questionNum === undefined || questionNum === null || questionNum === '') {
                    console.warn(`Question number missing for ${sectionName}, using fallback: ${questionCounter}`);
                    questionNum = questionCounter;
                }
                
                const questionId = `${sectionName}_${questionNum}`;
                questions.push({
                    id: questionId,
                    context: questionObj.context,
                    image_source: questionObj.image_source, // Include image source
                    question: qa.question,
                    question_type: qa.question_type,
                    options: qa.options,
                    answer: this.extractAnswerFromHtml(qa.answer, qa.question_type), // Extract just the letter/number
                    solution: qa.solution,
                    number: questionNum,
                    section: sectionName
                });
                questionCounter++;
            });
        });
        
        // Sort by number, handling both numeric and string cases
        return questions.sort((a, b) => {
            const aNum = parseInt(a.number) || 0;
            const bNum = parseInt(b.number) || 0;
            return aNum - bNum;
        });
    }

    generateQuestionPalette() {
        const paletteContainer = document.getElementById('paletteQuestions');
        if (!paletteContainer) {
            console.error('paletteQuestions container not found');
            return;
        }
        
        const currentQuestions = this.sectionQuestions[this.currentSection];
        if (!currentQuestions || !Array.isArray(currentQuestions) || currentQuestions.length === 0) {
            paletteContainer.innerHTML = '<p style="text-align: center; color: var(--text-light);">No questions available</p>';
            return;
        }
        
        paletteContainer.innerHTML = currentQuestions.map((q, index) => {
            // Use fallback numbering if q.number is undefined
            const displayNumber = q.number !== undefined ? q.number : (index + 1);
            return `
                <button class="question-btn" data-index="${index}" onclick="app.navigateToQuestion(${index})">
                    ${displayNumber}
                </button>
            `;
        }).join('');
        
        this.updatePaletteStatus();
    }

    updatePaletteStatus() {
        const buttons = document.querySelectorAll('#paletteQuestions .question-btn');
        const currentQuestions = this.sectionQuestions[this.currentSection];
        
        // Validate currentQuestions exists and is array
        if (!currentQuestions || !Array.isArray(currentQuestions)) {
            return;
        }
        
        buttons.forEach((btn, index) => {
            // Validate index is within bounds
            if (index >= currentQuestions.length) {
                return;
            }
            
            const question = currentQuestions[index];
            if (!question) {
                return;
            }
            
            const questionId = question.id;
            
            // Reset classes
            btn.className = 'question-btn';
            
            // Add status classes
            if (this.answers[questionId]) {
                btn.classList.add('answered');
            } else if (index <= this.currentQuestionIndex) {
                btn.classList.add('not-answered');
            }
            
            if (this.bookmarks.includes(questionId)) {
                btn.classList.add('bookmarked');
            }
            
            if (this.flags[questionId]) {
                btn.classList.add('flagged', this.flags[questionId]);
            }
            
            // Highlight current question
            if (index === this.currentQuestionIndex) {
                btn.style.transform = 'scale(1.1)';
                btn.style.boxShadow = '0 0 10px rgba(37, 99, 235, 0.5)';
            } else {
                btn.style.transform = '';
                btn.style.boxShadow = '';
            }
        });
    }

    displayQuestion() {
        const currentQuestions = this.sectionQuestions[this.currentSection];
        
        // Validate questions array exists and has items
        if (!currentQuestions || !Array.isArray(currentQuestions) || currentQuestions.length === 0) {
            console.error(`No questions available for section ${this.currentSection}`);
            this.showToast(`Error: No questions loaded for ${this.currentSection} section`, 'error');
            return;
        }
        
        // Validate and clamp question index
        if (this.currentQuestionIndex < 0) {
            this.currentQuestionIndex = 0;
        } else if (this.currentQuestionIndex >= currentQuestions.length) {
            this.currentQuestionIndex = currentQuestions.length - 1;
        }
        
        const question = currentQuestions[this.currentQuestionIndex];
        
        if (!question) {
            console.error(`Question at index ${this.currentQuestionIndex} not found`);
            return;
        }

        // Update section indicator (with null check)
        const sectionElement = document.getElementById('currentSection');
        if (sectionElement) {
            sectionElement.textContent = this.currentSection;
        }
        
        // Update question number (with null check)
        const questionNumberElement = document.getElementById('questionNumber');
        if (questionNumberElement) {
            questionNumberElement.textContent = 
                `Question ${this.currentQuestionIndex + 1} of ${currentQuestions.length}`;
        }
        
        // Update navigation buttons
        const prevBtn = document.querySelector('.nav-btn:first-child');
        const nextBtn = document.querySelector('.nav-btn:last-child');
        
        prevBtn.disabled = this.currentQuestionIndex === 0;
        nextBtn.disabled = this.currentQuestionIndex === currentQuestions.length - 1 && 
                          this.currentSection === 'QA';
        
        // Display context with image support
        const contextArea = document.getElementById('questionContext');
        let contextContent = '';
        
        // Add image if available (with path validation)
        if (question.image_source && typeof question.image_source === 'string') {
            // Sanitize image path to prevent directory traversal attacks
            let imagePath = question.image_source.replace('input/images/', '/static/images/');
            
            // Remove any path traversal attempts (..)
            imagePath = imagePath.replace(/\.\./g, '');
            
            // Ensure path starts with /static/images/ for security
            if (!imagePath.startsWith('/static/images/')) {
                console.warn(`Invalid image path format: ${question.image_source}. Using sanitized path.`);
                imagePath = '/static/images/' + imagePath.split('/').pop();
            }
            
            // Escape HTML in image source to prevent XSS
            const safeImageSource = this.escapeHtml(question.image_source);
            const safeImageName = safeImageSource.split('/').pop();
            
            contextContent += `
                <div class="question-image" style="text-align: center; margin-bottom: 1rem;">
                    <img src="${this.escapeHtml(imagePath)}" 
                         alt="Question diagram" 
                         style="max-width: 100%; height: auto; border: 1px solid var(--border-color); border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);"
                         onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
                    <div style="display: none; padding: 1rem; background: var(--warning-color); color: var(--text-primary); border: 1px solid var(--warning-color); border-radius: 4px; margin-top: 0.5rem; opacity: 0.1;">
                        <i class="fas fa-exclamation-triangle"></i> Image not available: ${safeImageName}
                    </div>
                </div>
            `;
        }
        
        // Add context text - render HTML properly (context from trusted backend)
        if (question.context && question.context.trim()) {
            // Render HTML directly since it comes from trusted backend source
            contextContent += question.context;
        }
        
        if (contextContent.trim()) {
            // Use innerHTML only for the formatted image, text is already escaped
            contextArea.innerHTML = contextContent;
            contextArea.style.display = 'block';
        } else {
            contextArea.style.display = 'none';
        }
        
        // Display question text (with null check)
        // Ensure HTML is rendered properly, not escaped
        const questionTextElement = document.querySelector('.question-text');
        if (questionTextElement && question.question) {
            // Directly set innerHTML to render HTML tags properly
            questionTextElement.innerHTML = question.question;
        } else if (questionTextElement) {
            questionTextElement.innerHTML = '';
        }
        
        // Display answer options
        this.displayAnswerOptions(question);
        
        // Update bookmark and flag states
        this.updateQuestionActions(question.id);
        
        // Start tracking time for this question
        this.questionStartTime = Date.now();
        
        // Trigger MathJax rendering
        this.renderMathJax();
        
        // Update palette
        this.updatePaletteStatus();
    }

    displayAnswerOptions(question) {
        const optionsContainer = document.getElementById('answerOptions');
        if (!optionsContainer) {
            console.error('answerOptions container not found');
            return;
        }
        
        if (question.question_type === 'Multiple Choice Question' && question.options) {
            // Helper function to process LaTeX in option text
            const processOptionText = (optionText) => {
                // Create a temporary div to extract text content (handles HTML tags)
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = optionText;
                let text = tempDiv.textContent || tempDiv.innerText || optionText;
                text = text.trim();
                
                // Check if text contains LaTeX commands (like \frac, \sqrt, etc.)
                // Pattern matches: \command, \command{...}, etc.
                const hasLatex = /\\[a-zA-Z]+\{?[^\}]*\}?/.test(text);
                
                if (hasLatex) {
                    // Check if already wrapped in MathJax delimiters ($, \( \), \[ \])
                    const hasDelimiters = /[\$]|\\\(|\\\[|\\\]|\\\)/.test(text);
                    
                    if (!hasDelimiters) {
                        // Split text into label part and content part
                        // Match patterns like "[2] ", "a) ", "1. ", etc. at the start
                        const labelMatch = text.match(/^(\[?\d+[a-z]?\]?\s*[-)]?\s*)/i);
                        
                        if (labelMatch) {
                            const label = labelMatch[1];
                            let content = text.substring(label.length).trim();
                            
                            // If original was HTML, preserve HTML structure but wrap LaTeX
                            if (optionText.includes('<')) {
                                // Replace the content part in the original HTML
                                // Find where the label ends in the HTML
                                const htmlLabelMatch = optionText.match(/^(<[^>]*>)?\[?\d+[a-z]?\]?\s*[-)]?\s*/i);
                                if (htmlLabelMatch) {
                                    const htmlLabel = htmlLabelMatch[0];
                                    const htmlContent = optionText.substring(htmlLabel.length);
                                    // Wrap LaTeX parts in the HTML content
                                    const processedContent = htmlContent.replace(
                                        /([^\<]*\\[a-zA-Z]+[^<]*)/,
                                        (match) => {
                                            // Check if this match has LaTeX
                                            if (/\\[a-zA-Z]+\{?[^\}]*\}?/.test(match) && !/[\$]|\\\(|\\\[/.test(match)) {
                                                return '\\( ' + match + ' \\)';
                                            }
                                            return match;
                                        }
                                    );
                                    return htmlLabel + processedContent;
                                }
                            }
                            
                            // For plain text, wrap only the content (not the label) in \( \) delimiters
                            return label + '\\( ' + content + ' \\)';
                        } else {
                            // No label found
                            if (optionText.includes('<')) {
                                // HTML: wrap LaTeX parts inside HTML tags
                                return optionText.replace(
                                    /(>[^<]*\\[a-zA-Z]+[^<]*)/,
                                    (match) => {
                                        const content = match.substring(1);
                                        if (/\\[a-zA-Z]+\{?[^\}]*\}?/.test(content) && !/[\$]|\\\(|\\\[/.test(content)) {
                                            return '>\\( ' + content + ' \\)';
                                        }
                                        return match;
                                    }
                                );
                            }
                            // Plain text: wrap entire content
                            return '\\( ' + text + ' \\)';
                        }
                    }
                }
                
                // No LaTeX found or already has delimiters
                return optionText;
            };
            
            // MCQ options - Use index-based mapping to ensure consistent option labels
            // Detect format from first option or correct answer, then map index accordingly
            // Supports both numeric (1, 2, 3, 4) and alphabetic (a, b, c, d) formats
            const firstOption = question.options && question.options.length > 0 ? question.options[0] : '';
            const firstChar = firstOption.trim().charAt(0);
            const isNumericFormat = /^\d/.test(firstChar);
            
            // Try to detect from correct answer if first option format is unclear
            let formatDetected = isNumericFormat;
            if (!isNumericFormat && !/^[a-zA-Z]/.test(firstChar) && question.answer) {
                // If first option doesn't start with digit or letter, check correct answer format
                const answerChar = String(question.answer).trim().charAt(0);
                formatDetected = /^\d/.test(answerChar);
            }
            
            optionsContainer.innerHTML = question.options.map((option, index) => {
                // Map index to label based on detected format:
                // Numeric: 0→'1', 1→'2', 2→'3', 3→'4'
                // Alphabetic: 0→'a', 1→'b', 2→'c', 3→'d'
                const optionLabel = formatDetected 
                    ? String(index + 1)  // Numeric: 1, 2, 3, 4
                    : String.fromCharCode(97 + index).toLowerCase(); // Alphabetic: a, b, c, d
                
                // Check if selected - support both formats (normalize for comparison)
                const savedAnswer = String(this.answers[question.id] || '').toLowerCase().trim();
                const isSelected = savedAnswer === optionLabel.toLowerCase() ||
                                   savedAnswer === String(index + 1) ||
                                   savedAnswer === String.fromCharCode(97 + index).toLowerCase();
                
                // Process option text to ensure LaTeX is properly formatted
                const processedOption = processOptionText(option);
                
                // Escape question.id and optionLabel to prevent XSS in onclick handler
                const safeQuestionId = this.escapeHtml(question.id).replace(/'/g, "\\'");
                const safeOptionLabel = this.escapeHtml(optionLabel).replace(/'/g, "\\'");
                
                return `
                    <div class="option ${isSelected ? 'selected' : ''}" 
                         data-question-id="${safeQuestionId}" 
                         data-option-label="${safeOptionLabel}"
                         onclick="app.selectOption('${safeQuestionId}', '${safeOptionLabel}')">
                        <input type="radio" name="answer" value="${optionLabel}" ${isSelected ? 'checked' : ''}>
                        <span>${processedOption}</span>
                    </div>
                `;
            }).join('');
        } else {
            // TITA input
            const currentAnswer = this.answers[question.id] || '';
            
            // Escape question.id to prevent XSS
            const safeQuestionId = this.escapeHtml(question.id).replace(/'/g, "\\'");
            const safeAnswer = this.escapeHtml(currentAnswer).replace(/"/g, "&quot;");
            
            optionsContainer.innerHTML = `
                <input type="text" class="tita-input" placeholder="Enter your answer" 
                       value="${safeAnswer}" 
                       data-question-id="${safeQuestionId}"
                       onchange="app.setTITAAnswer('${safeQuestionId}', this.value)">
            `;
        }
    }

    selectOption(questionId, optionLabel, eventElement = null) {
        // Normalize option label - preserve format (numeric stays numeric, letter stays letter but lowercase)
        const normalizedLabel = /^\d+$/.test(String(optionLabel).trim()) 
            ? String(optionLabel).trim()  // Numeric: keep as string (e.g., "1", "2")
            : String(optionLabel).toLowerCase().trim(); // Alphabetic: lowercase (e.g., "a", "b")
        this.answers[questionId] = normalizedLabel;
        
        // Update UI - remove selected class from all options
        document.querySelectorAll('.option').forEach(option => {
            option.classList.remove('selected');
            const radioInput = option.querySelector('input[type="radio"]');
            if (radioInput) {
                radioInput.checked = false;
            }
        });
        
        // Add selected class and check radio button for current option
        // Handle both event.currentTarget (from onclick) and explicit element parameter
        const targetElement = eventElement || (typeof event !== 'undefined' && event.currentTarget) || 
                             document.querySelector(`.option[data-question-id="${questionId}"][data-option-label="${optionLabel}"]`);
        
        if (targetElement) {
            targetElement.classList.add('selected');
            const radioInput = targetElement.querySelector('input[type="radio"]');
            if (radioInput) {
                radioInput.checked = true;
            }
        }
        
        // Submit answer (already normalized in selectOption)
        // Call without await to avoid blocking, but handle errors
        this.submitAnswer(questionId, normalizedLabel).catch((error) => {
            console.error('Error in submitAnswer (from selectOption):', error);
            // Error already logged in submitAnswer, just catch to prevent unhandled rejection
        });
        
        // Update palette
        this.updatePaletteStatus();
    }

    setTITAAnswer(questionId, value) {
        this.answers[questionId] = value.trim();
        // Call without await to avoid blocking, but handle errors
        this.submitAnswer(questionId, value.trim()).catch((error) => {
            console.error('Error in submitAnswer (from setTITAAnswer):', error);
            // Error already logged in submitAnswer, just catch to prevent unhandled rejection
        });
        this.updatePaletteStatus();
    }

    async submitAnswer(questionId, answer) {
        const timeSpent = this.questionStartTime ? 
            Math.floor((Date.now() - this.questionStartTime) / 1000) : 0;
        
        // Validate inputs before making API call
        if (!questionId || answer === undefined || answer === null) {
            console.error('Invalid submitAnswer call:', { questionId, answer });
            return;
        }
        
        if (!this.currentSession) {
            console.error('No active session when submitting answer');
            return;
        }
        
        try {
            // Add timeout to fetch to prevent hanging requests
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
            
            const response = await fetch('/api/submit-answer', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    session_id: this.currentSession,
                    question_id: questionId,
                    answer: answer,
                    time_spent: timeSpent
                }),
                signal: controller.signal
            }).finally(() => {
                clearTimeout(timeoutId);
            });
            
            // Check response status and handle errors
            if (!response.ok) {
                let errorData;
                try {
                    errorData = await this.safeJsonParse(response);
                } catch {
                    errorData = { detail: response.statusText || 'Failed to submit answer' };
                }
                console.error('Answer submission failed:', {
                    questionId,
                    status: response.status,
                    error: errorData.detail
                });
                // Don't show toast for every failure to avoid spam
                return;
            }
            
            // Parse successful response
            try {
                await this.safeJsonParse(response);
            } catch (parseError) {
                console.warn('Answer submitted but response parsing failed:', parseError);
            }
        } catch (error) {
            // Enhanced error logging
            if (error.name === 'AbortError') {
                console.error('Answer submission timed out:', questionId);
            } else if (error instanceof TypeError && error.message.includes('fetch')) {
                console.error('Network error submitting answer:', {
                    questionId,
                    error: error.message,
                    session: this.currentSession
                });
            } else {
                console.error('Error submitting answer:', {
                    questionId,
                    answer,
                    error: error.message,
                    stack: error.stack,
                    session: this.currentSession
                });
            }
            // Only show toast for non-network errors to avoid spam
            if (!error.message?.includes('fetch') && !error.message?.includes('network')) {
                this.showToast('Failed to save answer. Please try again.', 'error');
            }
            // Don't re-throw - we've handled the error
        }
    }

    updateQuestionActions(questionId) {
        // Update bookmark button
        const bookmarkBtn = document.getElementById('bookmarkBtn');
        const isBookmarked = this.bookmarks.includes(questionId);
        bookmarkBtn.innerHTML = isBookmarked ? 
            '<i class="fas fa-bookmark"></i> Bookmarked' : 
            '<i class="far fa-bookmark"></i> Bookmark';
    }

    // MathJax rendering helper with comprehensive error handling
    renderMathJax() {
        try {
            if (!window.MathJax) {
                console.warn('MathJax library not loaded');
                return;
            }
            
            const questionBody = document.getElementById('questionBody');
            if (!questionBody) {
                console.warn('questionBody element not found for MathJax rendering');
                return;
            }
            
            // MathJax v3 API (modern)
            if (MathJax.typesetPromise) {
                MathJax.typesetPromise([questionBody]).catch((err) => {
                    console.warn('MathJax v3 rendering error:', err);
                    // Fallback: try alternative rendering method
                    this.renderMathJaxFallback(questionBody);
                });
            } 
            // MathJax v2 API (legacy)
            else if (MathJax.Hub && MathJax.Hub.Queue) {
                try {
                    MathJax.Hub.Queue(["Typeset", MathJax.Hub, questionBody]);
                } catch (err) {
                    console.warn('MathJax v2 rendering error:', err);
                    this.renderMathJaxFallback(questionBody);
                }
            } 
            // Alternative v3 API
            else if (MathJax.typeset) {
                try {
                    MathJax.typeset([questionBody]);
                } catch (err) {
                    console.warn('MathJax alternative API rendering error:', err);
                    this.renderMathJaxFallback(questionBody);
                }
            } else {
                console.warn('MathJax API not recognized');
            }
        } catch (error) {
            console.error('Unexpected error in MathJax rendering:', error);
            // Ensure question is still displayed even if MathJax fails
        }
    }
    
    // Fallback MathJax rendering method
    renderMathJaxFallback(element) {
        try {
            // Try to manually trigger MathJax rendering with delay
            setTimeout(() => {
                if (window.MathJax && MathJax.typeset) {
                    MathJax.typeset([element]);
                }
            }, 500);
        } catch (err) {
            console.warn('MathJax fallback rendering also failed:', err);
        }
    }

    // Navigation Functions
    navigateToQuestion(index) {
        this.currentQuestionIndex = index;
        this.displayQuestion();
    }

    previousQuestion() {
        const currentQuestions = this.sectionQuestions[this.currentSection];
        
        // Validate questions array exists and has items
        if (!currentQuestions || !Array.isArray(currentQuestions) || currentQuestions.length === 0) {
            console.error('No questions available for navigation');
            return;
        }
        
        // Validate and clamp index before decrementing
        if (this.currentQuestionIndex > 0) {
            this.currentQuestionIndex--;
            this.displayQuestion();
        }
    }

    nextQuestion() {
        const currentQuestions = this.sectionQuestions[this.currentSection];
        
        // Validate questions array exists and has items
        if (!currentQuestions || !Array.isArray(currentQuestions) || currentQuestions.length === 0) {
            console.error('No questions available for navigation');
            return;
        }
        
        // Validate index bounds before incrementing
        if (this.currentQuestionIndex < 0) {
            this.currentQuestionIndex = 0;
        }
        
        if (this.currentQuestionIndex < currentQuestions.length - 1) {
            this.currentQuestionIndex++;
            this.displayQuestion();
        } else {
            // Move to next section
            this.moveToNextSection();
        }
    }

    moveToNextSection() {
        const sections = ['VARC', 'DILR', 'QA'];
        const currentSectionIndex = sections.indexOf(this.currentSection);
        
        if (currentSectionIndex < sections.length - 1) {
            this.switchSection(sections[currentSectionIndex + 1]);
        }
    }

    switchSection(section) {
        // Validate section name
        const validSections = ['VARC', 'DILR', 'QA'];
        if (!validSections.includes(section)) {
            console.error(`Invalid section name: ${section}. Defaulting to VARC.`);
            section = 'VARC';
        }
        
        this.currentSection = section;
        this.currentQuestionIndex = 0;
        
        // Update section tabs
        document.querySelectorAll('.section-tab').forEach(tab => {
            tab.classList.remove('active');
            if (tab.textContent.trim() === section) {
                tab.classList.add('active');
            }
        });
        
        // Generate new question palette for this section
        this.generateQuestionPalette();
        
        // Display first question of this section
        this.displayQuestion();
    }

    // Question Actions
    async toggleBookmark() {
        const currentQuestions = this.sectionQuestions[this.currentSection];
        
        // Validate questions array and index
        if (!currentQuestions || !Array.isArray(currentQuestions) || currentQuestions.length === 0) {
            console.error('No questions available for bookmark operation');
            return;
        }
        
        if (this.currentQuestionIndex < 0 || this.currentQuestionIndex >= currentQuestions.length) {
            console.error(`Invalid question index: ${this.currentQuestionIndex}`);
            return;
        }
        
        const question = currentQuestions[this.currentQuestionIndex];
        if (!question || !question.id) {
            console.error('Invalid question object');
            return;
        }
        
        const questionId = question.id;
        
        const isBookmarked = this.bookmarks.includes(questionId);
        const action = isBookmarked ? 'remove' : 'add';
        
        try {
            await fetch('/api/bookmark', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    session_id: this.currentSession,
                    question_id: questionId,
                    action: action
                })
            });
            
            if (isBookmarked) {
                this.bookmarks = this.bookmarks.filter(id => id !== questionId);
            } else {
                this.bookmarks.push(questionId);
            }
            
            this.updateQuestionActions(questionId);
            this.updatePaletteStatus();
            this.showToast(`Question ${action === 'add' ? 'bookmarked' : 'bookmark removed'}`, 'info');
        } catch (error) {
            console.error('Error toggling bookmark:', error);
        }
    }

    toggleFlagMenu() {
        document.getElementById('flagMenu').classList.toggle('active');
    }

    async setFlag(color) {
        const currentQuestions = this.sectionQuestions[this.currentSection];
        const question = currentQuestions[this.currentQuestionIndex];
        const questionId = question.id;
        
        try {
            await fetch('/api/flag', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    session_id: this.currentSession,
                    question_id: questionId,
                    color: color
                })
            });
            
            if (color === 'none') {
                delete this.flags[questionId];
                this.showToast('Flag removed', 'info');
            } else {
                this.flags[questionId] = color;
                this.showToast(`Question flagged as ${color}`, 'info');
            }
            
            this.updatePaletteStatus();
            document.getElementById('flagMenu').classList.remove('active');
        } catch (error) {
            console.error('Error setting flag:', error);
        }
    }

    // Timer Functions
    startTimer() {
        // Clear any existing timer interval first (prevent memory leaks)
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        
        // Ensure timeRemaining is never negative before starting
        this.timeRemaining = Math.max(0, this.timeRemaining || 7200);
        
        // If time is already expired, don't start timer, auto-submit instead
        if (this.timeRemaining <= 0) {
            this.showToast('⚠️ Test time has expired. Submitting automatically...', 'warning');
            setTimeout(() => {
                if (!this.isSubmitting && this.currentSession) {
                    this.submitTest();
                }
            }, 1000);
            return;
        }
        
        // Update display immediately
        const timeElement = document.getElementById('timeRemaining');
        if (timeElement) {
            timeElement.textContent = this.formatTime(this.timeRemaining);
        }
        
        this.timerInterval = setInterval(() => {
            // Ensure time never goes below 0
            if (this.timeRemaining > 0) {
                this.timeRemaining--;
            } else {
                this.timeRemaining = 0; // Clamp to 0
            }
            
            const timeElement = document.getElementById('timeRemaining');
            if (timeElement) {
                timeElement.textContent = this.formatTime(this.timeRemaining);
            }
            
            // Time warnings
            if (this.timeRemaining === 600) { // 10 minutes
                this.showToast('10 minutes remaining!', 'warning');
            } else if (this.timeRemaining === 300) { // 5 minutes
                this.showToast('5 minutes remaining!', 'warning');
            } else if (this.timeRemaining === 60) { // 1 minute
                this.showToast('1 minute remaining!', 'warning');
            } else if (this.timeRemaining <= 0) {
                // Clear timer immediately to prevent race conditions
                if (this.timerInterval) {
                    clearInterval(this.timerInterval);
                    this.timerInterval = null;
                }
                // Auto-submit if not already submitting
                if (!this.isSubmitting) {
                    this.submitTest();
                }
            }
        }, 1000);
    }

    startAutoSave() {
        // Clear any existing auto-save interval first (prevent memory leaks)
        if (this.autoSaveInterval) {
            clearInterval(this.autoSaveInterval);
            this.autoSaveInterval = null;
        }
        
        this.autoSaveInterval = setInterval(() => {
            // Wrap in async IIFE to handle errors properly
            (async () => {
                try {
                    await this.saveSession();
                } catch (error) {
                    // Silently handle auto-save errors to avoid interrupting user
                    console.warn('Auto-save failed (will retry):', error.message);
                }
            })();
        }, 30000); // Auto-save every 30 seconds
    }

    // Wait for DOM element to be ready
    async waitForDOMReady(selector, timeout = 5000) {
        return new Promise((resolve, reject) => {
            // Check if element already exists
            if (document.querySelector(selector)) {
                resolve();
                return;
            }
            
            // Use MutationObserver to watch for element
            const observer = new MutationObserver((mutations, obs) => {
                if (document.querySelector(selector)) {
                    obs.disconnect();
                    resolve();
                }
            });
            
            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
            
            // Timeout fallback
            setTimeout(() => {
                observer.disconnect();
                if (document.querySelector(selector)) {
                    resolve();
                } else {
                    // Don't reject - just warn and continue
                    console.warn(`Element ${selector} not found after ${timeout}ms, continuing anyway`);
                    resolve();
                }
            }, timeout);
        });
    }

    // Session Management
    async saveSession() {
        if (!this.currentSession) {
            console.log('No current session to save');
            return;
        }
        
        console.log('Attempting to save session:', this.currentSession);
        
        try {
            // Add timeout to prevent hanging
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout
            
            const response = await fetch('/api/save-session', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    session_id: this.currentSession
                }),
                signal: controller.signal
            }).finally(() => {
                clearTimeout(timeoutId);
            });
            
            console.log('Save session response status:', response.status);
            
            if (!response.ok) {
                let errorData;
                try {
                    errorData = await this.safeJsonParse(response);
                } catch {
                    errorData = { detail: response.statusText };
                }
                throw new Error(`Save failed: ${errorData.detail || response.statusText}`);
            }
            
            const result = await this.safeJsonParse(response);
            console.log('Save session result:', result);
        } catch (error) {
            // Enhanced error logging
            if (error.name === 'AbortError') {
                console.error('Session save timed out:', this.currentSession);
            } else {
                console.error('Error saving session:', {
                    session: this.currentSession,
                    error: error.message,
                    stack: error.stack
                });
            }
            throw error; // Re-throw to allow proper error handling in submitTest
        }
    }

    async pauseTest() {
        if (!confirm('Are you sure you want to pause the test? You can resume later from where you left off.')) {
            return;
        }
        
        try {
            await fetch('/api/pause-test', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    session_id: this.currentSession
                })
            });
            
            if (this.timerInterval) clearInterval(this.timerInterval);
            if (this.autoSaveInterval) clearInterval(this.autoSaveInterval);
            
            this.showToast('Test paused successfully!', 'success');
            
            // Return to dashboard and refresh all data to show paused test
            await this.returnToDashboard();
        } catch (error) {
            console.error('Error pausing test:', error);
            this.showToast('Failed to pause test', 'error');
        }
    }

    async saveTest() {
        try {
            await this.saveSession();
            this.showToast('Test progress saved successfully!', 'success');
        } catch (error) {
            console.error('Error saving test:', error);
            this.showToast('Failed to save test progress', 'error');
        }
    }

    async submitTest() {
        // Prevent multiple submissions
        if (this.isSubmitting) {
            console.warn('Test submission already in progress');
            return;
        }
        
        if (!confirm('Are you sure you want to submit the test? This action cannot be undone.')) {
            return;
        }
        
        // Store button references before any async operations
        const submitButtons = document.querySelectorAll('[onclick*="submitTest"]');
        
        // Set submission flag to prevent duplicates
        this.isSubmitting = true;
        
        // Disable submit button to prevent double-clicks
        submitButtons.forEach(btn => {
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting...';
            }
        });
        
        try {
            // Clear intervals immediately to prevent race conditions
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }
            if (this.autoSaveInterval) {
                clearInterval(this.autoSaveInterval);
                this.autoSaveInterval = null;
            }
            
            // Save session with timeout protection
            const savePromise = this.saveSession();
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Save timeout')), 10000) // 10 second timeout
            );
            
            try {
                await Promise.race([savePromise, timeoutPromise]);
                console.log('Session saved successfully before submission');
            } catch (error) {
                console.error('Save session failed:', error);
                this.showToast('Failed to save test progress. Submission cancelled.', 'error');
                
                // Re-enable submit button and reset flag
                this.isSubmitting = false;
                submitButtons.forEach(btn => {
                    if (btn) {
                        btn.disabled = false;
                        btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit';
                    }
                });
                return; // Stop submission if save fails
            }
            
            // Show results page FIRST so DOM elements exist before we try to update them
            this.showPage('resultsPage');
            
            // Wait for DOM to be ready - use MutationObserver for reliability
            await this.waitForDOMReady('#resultsPage .results-grid');
            
            // Verify all required DOM elements exist before proceeding
            const requiredElements = ['totalScore', 'varcScore', 'dilrScore', 'qaScore', 'accuracyPercent', 'totalTimeSpent', 'avgTimePerQ'];
            const missingElements = requiredElements.filter(id => !document.getElementById(id));
            
            if (missingElements.length > 0) {
                throw new Error(`Required DOM elements missing: ${missingElements.join(', ')}. Results page may not have loaded properly.`);
            }
            
            // Calculate results - now DOM elements should exist
            try {
                this.calculateResults();
            } catch (calcError) {
                console.error('Error calculating results:', calcError);
                throw new Error(`Failed to calculate results: ${calcError.message}`);
            }
            
            // Mark test as completed on backend
            if (this.currentSession) {
                try {
                    const completeResponse = await fetch('/api/complete-test', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ session_id: this.currentSession })
                    });
                    
                    if (!completeResponse.ok) {
                        const errorData = await completeResponse.json().catch(() => ({ detail: completeResponse.statusText }));
                        console.warn('Failed to mark test as completed:', errorData.detail);
                        // Don't throw - results are already shown, this is just cleanup
                    }
                } catch (error) {
                    console.error('Error marking test as completed:', error);
                    // Continue anyway - results are shown
                }
            }
            
            // Show success message
            this.showToast('Test submitted successfully!', 'success');
            
            // Clear current session to prevent confusion with next test
            this.currentSession = null;
            
            // Reset submission flag and re-enable buttons (even though page is hidden, reset for future use)
            this.isSubmitting = false;
            submitButtons.forEach(btn => {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit';
                }
            });
            
            // Also reset any submit buttons that might exist in DOM (in case page navigation happened)
            document.querySelectorAll('[onclick*="submitTest"]').forEach(btn => {
                if (btn && btn.disabled) {
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit';
                }
            });
            
            // Force refresh progress when test is completed
            setTimeout(() => {
                if (this.currentUser) {
                    this.loadUserProgress();
                }
            }, 1000);
            
        } catch (error) {
            // Comprehensive error logging
            const errorDetails = {
                message: error.message,
                stack: error.stack,
                name: error.name,
                currentSession: this.currentSession,
                sectionQuestions: Object.keys(this.sectionQuestions),
                answersCount: Object.keys(this.answers).length,
                timeRemaining: this.timeRemaining,
                timestamp: new Date().toISOString()
            };
            
            console.error('❌ SUBMISSION ERROR:', error);
            console.error('📋 Error Details:', errorDetails);
            
            // Store error in localStorage for debugging
            try {
                const errorLog = JSON.parse(localStorage.getItem('submissionErrors') || '[]');
                errorLog.push({
                    ...errorDetails,
                    timestamp: new Date().toISOString()
                });
                // Keep only last 5 errors
                if (errorLog.length > 5) {
                    errorLog.shift();
                }
                localStorage.setItem('submissionErrors', JSON.stringify(errorLog));
            } catch (e) {
                console.warn('Could not save error to localStorage:', e);
            }
            
            // Show persistent error message that won't disappear
            const errorMsg = error.message || 'Unknown error occurred';
            const detailedError = `Error submitting test: ${errorMsg}\n\nIf this persists, please check the browser console (F12) for details.`;
            
            // Show both toast (temporary) and persistent error (requires dismissal)
            this.showToast(detailedError, 'error', false); // Regular toast for quick view
            this.showPersistentError(detailedError); // Persistent error that stays until dismissed
            
            // Re-enable submit button and reset flag
            this.isSubmitting = false;
            submitButtons.forEach(btn => {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit';
                }
            });
            
            // Also reset any submit buttons that might exist in DOM
            document.querySelectorAll('[onclick*="submitTest"]').forEach(btn => {
                if (btn && btn.disabled) {
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit';
                }
            });
        }
    }

    calculateResults() {
        // Validate that sectionQuestions exists and has data
        if (!this.sectionQuestions || typeof this.sectionQuestions !== 'object') {
            throw new Error('Section questions data is missing or invalid');
        }
        
        // Validate that answers exists
        if (!this.answers || typeof this.answers !== 'object') {
            console.warn('Answers object is missing, initializing empty');
            this.answers = {};
        }
        
        let totalScore = 0;
        let sectionScores = { VARC: 0, DILR: 0, QA: 0 };
        let sectionStats = {
            VARC: { attempted: 0, correct: 0, total: 0, marks: 0 },
            DILR: { attempted: 0, correct: 0, total: 0, marks: 0 },
            QA: { attempted: 0, correct: 0, total: 0, marks: 0 }
        };
        let totalQuestions = 0;
        let totalAttempted = 0;
        let correctAnswers = 0;
        
        // Calculate detailed stats for each section
        try {
            Object.keys(this.sectionQuestions).forEach(section => {
                const questions = this.sectionQuestions[section];
                if (!Array.isArray(questions)) {
                    console.warn(`Section ${section} questions is not an array`);
                    return;
                }
                
                let sectionMarks = 0;
                
                // Set actual total for this section
                sectionStats[section].total = questions.length;
                totalQuestions += questions.length;
                
                questions.forEach(question => {
                    if (!question || !question.id) {
                        console.warn('Invalid question object in section', section);
                        return;
                    }
                    
                    const userAnswer = this.answers[question.id];
                    
                    // Only count questions that were actually answered (not empty/null)
                    if (userAnswer && typeof userAnswer === 'string' && userAnswer.trim() !== '') {
                        sectionStats[section].attempted++;
                        totalAttempted++;
                        
                        // Validate question has answer property
                        if (question.answer) {
                            if (userAnswer.toLowerCase().trim() === String(question.answer).toLowerCase().trim()) {
                                sectionStats[section].correct++;
                                correctAnswers++;
                                sectionMarks += 3; // +3 for correct answer
                            } else if (question.question_type === 'Multiple Choice Question') {
                                sectionMarks -= 1; // -1 for wrong MCQ answer
                            }
                            // TITA wrong answers get 0 marks (no negative marking)
                        }
                    }
                });
                
                sectionStats[section].marks = sectionMarks; // Allow negative marks for sections
                sectionScores[section] = sectionStats[section].marks;
                totalScore += sectionStats[section].marks;
            });
        } catch (calcError) {
            throw new Error(`Error calculating section statistics: ${calcError.message}`);
        }
        
        // Update basic results display - WITH NULL CHECKS to prevent crashes
        const totalScoreEl = document.getElementById('totalScore');
        if (totalScoreEl) totalScoreEl.textContent = totalScore;
        
        const varcScoreEl = document.getElementById('varcScore');
        if (varcScoreEl) varcScoreEl.textContent = `${sectionScores.VARC}/${sectionStats.VARC.total * 3}`;
        
        const dilrScoreEl = document.getElementById('dilrScore');
        if (dilrScoreEl) dilrScoreEl.textContent = `${sectionScores.DILR}/${sectionStats.DILR.total * 3}`;
        
        const qaScoreEl = document.getElementById('qaScore');
        if (qaScoreEl) qaScoreEl.textContent = `${sectionScores.QA}/${sectionStats.QA.total * 3}`;
        
        // Calculate accuracy safely (avoid division by zero)
        const accuracyPercent = totalAttempted > 0 
            ? Math.round((correctAnswers / totalAttempted) * 100) 
            : 0;
        const accuracyPercentEl = document.getElementById('accuracyPercent');
        if (accuracyPercentEl) accuracyPercentEl.textContent = `${accuracyPercent}%`;
        
        // Calculate time spent
        const timeSpent = 7200 - this.timeRemaining;
        const totalTimeSpentEl = document.getElementById('totalTimeSpent');
        if (totalTimeSpentEl) totalTimeSpentEl.textContent = this.formatTime(timeSpent);
        
        // Calculate average time per question safely
        const avgTimePerQ = totalAttempted > 0 
            ? Math.floor(timeSpent / totalAttempted) 
            : 0;
        // Safe substring - check length first
        const formattedTime = avgTimePerQ > 0 ? this.formatTime(avgTimePerQ) : '00:00:00';
        const avgTimePerQEl = document.getElementById('avgTimePerQ');
        if (avgTimePerQEl) {
            avgTimePerQEl.textContent = 
                avgTimePerQ > 0 && formattedTime.length > 3 ? formattedTime.substring(3) : '0:00'; // Remove hours if long enough
        }
            
        // Update detailed breakdown - with error handling
        try {
            this.displayDetailedResults(sectionStats, totalAttempted, correctAnswers, totalScore);
        } catch (displayError) {
            console.error('Error displaying detailed results:', displayError);
            // Don't throw - basic results are already shown
            // Just log the error and continue
        }
    }
    
    displayDetailedResults(sectionStats, totalAttempted, correctAnswers, totalScore, totalQuestions = 0) {
        // Create detailed breakdown display
        const detailedBreakdown = `
            <div class="detailed-results-breakdown" style="margin: 2rem 0; background: var(--surface-color); padding: 1.5rem; border-radius: var(--border-radius); border-left: 4px solid var(--primary-color);">
                <h3 style="color: var(--primary-color); margin: 0 0 1rem 0;">
                    <i class="fas fa-chart-pie"></i> Detailed Performance Breakdown
                </h3>
                
                <!-- Overall Summary -->
                <div style="background: linear-gradient(135deg, #2563eb, #7c3aed); color: white; padding: 1.5rem; border-radius: 8px; margin-bottom: 1rem; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                    <h4 style="margin: 0 0 1rem 0; text-align: center; color: white; font-weight: 600;">Overall Performance</h4>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 1rem; text-align: center;">
                        <div style="background: rgba(255, 255, 255, 0.15); padding: 0.75rem; border-radius: 6px;">
                            <div style="font-size: 1.8rem; font-weight: bold; color: white;">${totalAttempted}</div>
                            <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.9rem;">Questions Attempted</div>
                        </div>
                        <div style="background: rgba(255, 255, 255, 0.15); padding: 0.75rem; border-radius: 6px;">
                            <div style="font-size: 1.8rem; font-weight: bold; color: white;">${correctAnswers}</div>
                            <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.9rem;">Correct Answers</div>
                        </div>
                        <div style="background: rgba(255, 255, 255, 0.15); padding: 0.75rem; border-radius: 6px;">
                            <div style="font-size: 1.8rem; font-weight: bold; color: white;">${totalScore}</div>
                            <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.9rem;">Marks Scored</div>
                        </div>
                        <div style="background: rgba(255, 255, 255, 0.15); padding: 0.75rem; border-radius: 6px;">
                            <div style="font-size: 1.8rem; font-weight: bold; color: white;">${totalAttempted > 0 ? Math.round((correctAnswers/totalAttempted)*100) : 0}%</div>
                            <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.9rem;">Accuracy</div>
                        </div>
                    </div>
                </div>
                
                <!-- Section-wise Breakdown -->
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem;">
                    ${Object.keys(sectionStats).map(section => {
                        const stats = sectionStats[section];
                        const accuracy = stats.attempted > 0 ? Math.round((stats.correct / stats.attempted) * 100) : 0;
                        const sectionName = section === 'VARC' ? 'Verbal (VARC)' : 
                                          section === 'DILR' ? 'Data & Logic (DILR)' : 
                                          'Quantitative (QA)';
                        const maxMarks = stats.total * 3;
                        
                        return `
                        <div style="background: var(--surface-color); border: 1px solid var(--border-color); border-radius: 8px; padding: 1rem;">
                            <h5 style="color: var(--primary-color); margin: 0 0 1rem 0; text-align: center;">${sectionName}</h5>
                            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem; font-size: 0.9rem; color: var(--text-primary);">
                                <div><strong style="color: var(--text-primary);">Total Questions:</strong> ${stats.total}</div>
                                <div><strong style="color: var(--text-primary);">Attempted:</strong> ${stats.attempted}</div>
                                <div><strong style="color: var(--text-primary);">Correct:</strong> ${stats.correct}</div>
                                <div><strong style="color: var(--text-primary);">Accuracy:</strong> ${accuracy}%</div>
                                <div style="grid-column: span 2; margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border-color);">
                                    <strong style="color: var(--primary-color);">Marks: ${stats.marks}/${maxMarks}</strong>
                                </div>
                            </div>
                        </div>
                        `;
                    }).join('')}
                </div>
                
                <!-- Answered Questions Table -->
                <div style="margin-top: 1.5rem; background: var(--surface-color); border: 1px solid var(--border-color); border-radius: 8px; padding: 1rem;">
                    <h4 style="color: var(--primary-color); margin: 0 0 1rem 0;">
                        <i class="fas fa-list-alt"></i> Answered Questions Details
                    </h4>
                    <div id="answeredQuestionsTable">
                        <!-- Table will be populated by displayAnsweredQuestionsTable -->
                    </div>
                </div>
            </div>
        `;
        
        // Insert after the results grid - WITH NULL CHECK to prevent crashes
        const resultsGrid = document.querySelector('.results-grid');
        if (!resultsGrid) {
            console.error('Results grid not found - cannot display detailed results');
            return; // Exit early if results grid doesn't exist
        }
        
        let existingBreakdown = document.querySelector('.detailed-results-breakdown');
        if (existingBreakdown) {
            existingBreakdown.remove();
        }
        resultsGrid.insertAdjacentHTML('afterend', detailedBreakdown);
        
        // Populate the answered questions table - with error handling
        try {
            this.displayAnsweredQuestionsTable();
        } catch (tableError) {
            console.error('Error displaying answered questions table:', tableError);
            // Show error in the table container if it exists
            const tableContainer = document.getElementById('answeredQuestionsTable');
            if (tableContainer) {
                tableContainer.innerHTML = `<div style="color: var(--danger-color); padding: 1rem;">Error loading answered questions table: ${tableError.message}</div>`;
            }
            // Don't throw - basic results are already shown
        }
    }

    displayAnsweredQuestionsTable() {
        const tableContainer = document.getElementById('answeredQuestionsTable');
        if (!tableContainer) return;

        // Get answered questions data
        const answeredQuestions = [];
        
        // Only process answers that are non-empty and actually answered
        Object.keys(this.answers).forEach(questionId => {
            const answer = this.answers[questionId];
            // Strict check: only include questions with actual non-empty answers
            // Handle both string and non-string types safely
            const answerStr = typeof answer === 'string' ? answer : String(answer || '');
            if (!answerStr || answerStr.trim() === '' || answerStr === 'null' || answerStr === 'undefined' || answerStr === 'NaN') {
                return; // Skip unanswered questions
            }
            
            // Use normalized answer for processing
            const normalizedAnswer = answerStr.trim();
            
            // Find the question data
            let questionData = null;
            let section = '';
            
            for (const [sectionName, questions] of Object.entries(this.sectionQuestions)) {
                const question = questions.find(q => q.id === questionId);
                if (question) {
                    questionData = question;
                    section = sectionName;
                    break;
                }
            }
            
            if (questionData) {
                // Normalize both answers for comparison - handle both numeric and alphabetic formats
                const normalizedUserAnswer = normalizedAnswer.toLowerCase();
                const normalizedCorrectAnswer = String(questionData.answer || '').trim().toLowerCase();
                // Also handle numeric comparison (e.g., "1" === "1")
                const isCorrect = normalizedUserAnswer === normalizedCorrectAnswer ||
                                 normalizedAnswer === String(questionData.answer || '').trim();
                const marks = isCorrect ? 3 : (questionData.question_type === 'Multiple Choice Question' ? -1 : 0);
                
                // Safe substring for question text
                const questionText = this.cleanHtmlText(questionData.question || '');
                const displayText = questionText.length > 100 ? questionText.substring(0, 100) + '...' : questionText;
                
                // Format answer display based on question type
                let userAnswerDisplay = normalizedAnswer;
                let correctAnswerDisplay = String(questionData.answer || '');
                
                // For MCQ, show option numbers (a, b, c, d)
                if (questionData.question_type === 'Multiple Choice Question' && questionData.options) {
                    const userAnswerLower = normalizedAnswer.toLowerCase();
                    const correctAnswerLower = String(questionData.answer || '').toLowerCase().trim();
                    
                    // Convert answer letter (a, b, c, d) to Option A, B, C, D
                    if (userAnswerLower && userAnswerLower.length === 1 && userAnswerLower >= 'a' && userAnswerLower <= 'z') {
                        const optionLetter = userAnswerLower.toUpperCase();
                        userAnswerDisplay = `Option ${optionLetter}`;
                        if (isCorrect) {
                            userAnswerDisplay += ' (Your Choice & Correct)';
                        } else {
                            userAnswerDisplay += ' (Your Choice)';
                        }
                    }
                    
                    if (correctAnswerLower && correctAnswerLower.length === 1 && correctAnswerLower >= 'a' && correctAnswerLower <= 'z') {
                        const optionLetter = correctAnswerLower.toUpperCase();
                        correctAnswerDisplay = `Option ${optionLetter}`;
                        if (!isCorrect) {
                            correctAnswerDisplay += ' (Correct Answer)';
                        }
                    }
                }
                // For TITA, just show the value (answer is already stored as the numeric value)
                
                answeredQuestions.push({
                    questionId: questionId,
                    section: section,
                    questionNumber: questionData.number || '',
                    questionText: displayText,
                    userAnswer: normalizedAnswer, // Use normalized answer (from this.answers) to ensure consistency
                    userAnswerDisplay: userAnswerDisplay,
                    correctAnswer: questionData.answer,
                    correctAnswerDisplay: correctAnswerDisplay,
                    isCorrect: isCorrect,
                    marks: marks,
                    questionType: questionData.question_type,
                    options: questionData.options || []
                });
            }
        });

        if (answeredQuestions.length === 0) {
            tableContainer.innerHTML = '<p style="text-align: center; color: var(--text-secondary); font-style: italic; padding: 2rem;">No questions were answered in this test.</p>';
            return;
        }

        // Sort by section
        const sectionOrder = { 'VARC': 1, 'DILR': 2, 'QA': 3 };
        answeredQuestions.sort((a, b) => sectionOrder[a.section] - sectionOrder[b.section]);

        // Create table HTML
        const tableHTML = `
            <div style="overflow-x: auto; border: 1px solid var(--border-color); border-radius: 8px;">
                <table style="width: 100%; border-collapse: collapse;">
                    <thead>
                        <tr style="background: var(--primary-color); color: white;">
                            <th style="padding: 12px; text-align: center; font-weight: bold; border-right: 1px solid rgba(255,255,255,0.2);">Question #</th>
                            <th style="padding: 12px; text-align: left; font-weight: bold; border-right: 1px solid rgba(255,255,255,0.2);">Section</th>
                            <th style="padding: 12px; text-align: left; font-weight: bold; border-right: 1px solid rgba(255,255,255,0.2);">Question (Preview)</th>
                            <th style="padding: 12px; text-align: center; font-weight: bold; border-right: 1px solid rgba(255,255,255,0.2);">Your Answer</th>
                            <th style="padding: 12px; text-align: center; font-weight: bold; border-right: 1px solid rgba(255,255,255,0.2);">Correct Answer</th>
                            <th style="padding: 12px; text-align: center; font-weight: bold; border-right: 1px solid rgba(255,255,255,0.2);">Result</th>
                            <th style="padding: 12px; text-align: center; font-weight: bold;">Marks</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${answeredQuestions.map((q, index) => {
                            const rowBg = index % 2 === 0 ? 'var(--surface-color)' : 'var(--background-color)';
                            const statusIcon = q.isCorrect ? '✅' : '❌';
                            const statusText = q.isCorrect ? 'Correct' : 'Incorrect';
                            const statusColor = q.isCorrect ? 'var(--success-color)' : 'var(--danger-color)';
                            const marksColor = q.marks > 0 ? 'var(--success-color)' : q.marks < 0 ? 'var(--danger-color)' : 'var(--text-secondary)';
                            
                            return `
                                <tr style="background: ${rowBg}; border-bottom: 1px solid var(--border-color);">
                                    <td style="padding: 12px; text-align: center; border-right: 1px solid var(--border-color); vertical-align: top;">
                                        <span style="background: var(--primary-color); color: white; padding: 6px 10px; border-radius: 6px; font-weight: bold; font-size: 1rem;">${this.escapeHtml(String(q.questionNumber || ''))}</span>
                                    </td>
                                    <td style="padding: 12px; border-right: 1px solid var(--border-color); vertical-align: top;">
                                        <span style="background: var(--secondary-color); color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.8rem; font-weight: bold;">${this.escapeHtml(q.section || '')}</span>
                                    </td>
                                    <td style="padding: 12px; border-right: 1px solid var(--border-color); max-width: 300px; color: var(--text-primary); font-size: 0.9rem; vertical-align: top;">
                                        ${this.escapeHtml(q.questionText || '')}
                                    </td>
                                    <td style="padding: 12px; text-align: center; border-right: 1px solid var(--border-color); vertical-align: top;">
                                        <span class="answer-badge-user" style="background: #dbeafe; color: #1d4ed8; padding: 6px 12px; border-radius: 6px; font-weight: bold; font-size: 0.9rem;">${this.escapeHtml(q.userAnswerDisplay || q.userAnswer || '').toUpperCase()}</span>
                                    </td>
                                    <td style="padding: 12px; text-align: center; border-right: 1px solid var(--border-color); vertical-align: top;">
                                        <span class="answer-badge-correct" style="background: #dcfce7; color: #16a34a; padding: 6px 12px; border-radius: 6px; font-weight: bold; font-size: 0.9rem;">${this.escapeHtml(q.correctAnswerDisplay || q.correctAnswer || '').toUpperCase()}</span>
                                    </td>
                                    <td style="padding: 12px; text-align: center; border-right: 1px solid var(--border-color); vertical-align: top;">
                                        <div style="display: flex; align-items: center; justify-content: center; gap: 0.5rem; color: ${statusColor};">
                                            <span style="font-size: 1.2rem;">${statusIcon}</span>
                                            <span style="font-weight: 600;">${statusText}</span>
                                        </div>
                                    </td>
                                    <td style="padding: 12px; text-align: center; font-weight: bold; font-size: 1.2rem; color: ${marksColor}; vertical-align: top;">
                                        ${q.marks > 0 ? '+' : ''}${q.marks}
                                    </td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
            <div style="margin-top: 1rem; text-align: center; color: var(--text-light); font-size: 0.9rem;">
                <i class="fas fa-info-circle"></i> Showing ${answeredQuestions.length} answered questions • Total Questions: 66 • Remaining: ${66 - answeredQuestions.length}
            </div>
        `;
        
        tableContainer.innerHTML = tableHTML;
    }

    cleanHtmlText(html) {
        // Handle null/undefined
        if (!html) return '';
        // Create a temporary element to strip HTML tags
        const temp = document.createElement('div');
        temp.innerHTML = html;
        return temp.textContent || temp.innerText || '';
    }

    /**
     * Extract the option letter/number from an HTML-formatted answer.
     * Handles formats like "<p>b) text...</p>" -> "b"
     * or "<p>1) text...</p>" -> "1"
     * For MCQ questions, returns just the letter/number.
     * For TITA questions, returns the cleaned text.
     */
    extractAnswerFromHtml(htmlAnswer, questionType) {
        if (!htmlAnswer) return '';
        
        // For TITA questions, return cleaned text without option extraction
        if (questionType === 'Type in the Answer' || questionType === 'TITA') {
            return this.cleanHtmlText(htmlAnswer).trim();
        }
        
        // For MCQ, extract option letter/number
        const cleaned = this.cleanHtmlText(htmlAnswer).trim();
        
        // Match pattern like "b) text" or "1) text" - extract the letter/number before )
        const match = cleaned.match(/^([a-zA-Z0-9]+)\)\s*/);
        if (match) {
            return match[1].toLowerCase(); // Return lowercase letter or number as string
        }
        
        // Fallback: if it's just a single letter/number, return it
        if (cleaned.length === 1 && /[a-zA-Z0-9]/.test(cleaned)) {
            return cleaned.toLowerCase();
        }
        
        // If no match, return cleaned text (shouldn't happen for MCQ, but safe fallback)
        return cleaned;
    }

    // Escape HTML to prevent XSS
    escapeHtml(text) {
        if (text === null || text === undefined) {
            return '';
        }
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
    }

    // Safe JSON parsing helper - checks content-type and handles errors
    async safeJsonParse(response) {
        try {
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const text = await response.text();
                throw new Error(text || `Server returned ${response.status}: ${response.statusText}`);
            }
            return await response.json();
        } catch (parseError) {
            console.error('Error parsing JSON response:', parseError);
            throw new Error(parseError.message || 'Invalid response format from server');
        }
    }

    // Results and AI Functions
    async generateAIFeedback() {
        if (!this.currentUser) return;
        
        // Show loading state
        document.querySelector('.analysis-content').innerHTML = `
            <div style="text-align: center; padding: 2rem;">
                <i class="fas fa-spinner fa-spin" style="font-size: 3rem; color: var(--primary-color); margin-bottom: 1rem;"></i>
                <h3>AI Performance Analysis</h3>
                <p>Generating detailed analysis...</p>
            </div>
        `;
        
        try {
            const response = await fetch(`/api/ai-analysis/${this.currentUser.username}`);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const analysisData = await this.safeJsonParse(response);
            
            if (analysisData.status === 'unavailable') {
                document.querySelector('.analysis-content').innerHTML = `
                    <div style="padding: 2rem;">
                        <div style="text-align: center; margin-bottom: 2rem;">
                            <i class="fas fa-exclamation-triangle" style="font-size: 3rem; color: var(--warning-color); margin-bottom: 1rem;"></i>
                            <h3>AI Analysis Unavailable</h3>
                            <p>${this.escapeHtml(analysisData.message || '')}</p>
                        </div>
                        <div style="background: var(--surface-color); padding: 1.5rem; border-radius: var(--border-radius); border-left: 4px solid var(--primary-color);">
                            <h4>📊 Basic Performance Summary Available</h4>
                            <p>While AI analysis is unavailable, you can still view your detailed progress statistics above.</p>
                            <p><strong>To enable AI analysis:</strong></p>
                            <ul>
                                <li>Add your OpenAI API key to the .env file, OR</li>
                                <li>Set up a local LLM using LM Studio</li>
                            </ul>
                        </div>
                    </div>
                `;
                return;
            }
            
            // Display successful analysis with marks and follow-up feature
            const perfData = analysisData.performance_data;
            const marksHtml = this.generateMarksDisplay(perfData);
            
            document.querySelector('.analysis-content').innerHTML = `
                <div style="padding: 1.5rem;">
                    ${marksHtml}
                    <div style="margin-top: 2rem; background: var(--surface-color); padding: 1.5rem; border-radius: var(--border-radius);">
                        <div style="display: flex; align-items: center; margin-bottom: 1rem;">
                            <i class="fas fa-robot" style="color: var(--primary-color); margin-right: 0.5rem;"></i>
                            <h3 style="margin: 0;">Detailed Analysis ${analysisData.ai_powered ? '(AI-Powered)' : '(Basic)'}</h3>
                        </div>
                        <div class="analysis-text" style="line-height: 1.6;">
                            ${this.formatAnalysisText(analysisData.analysis)}
                        </div>
                        
                        <!-- Follow-up Question Feature -->
                        <div style="margin-top: 2rem; padding: 1.5rem; background: rgba(var(--primary-color-rgb), 0.05); border-radius: 8px; border-left: 4px solid var(--primary-color);">
                            <h4 style="margin: 0 0 1rem 0; color: var(--primary-color);">
                                <i class="fas fa-question-circle"></i> Ask Follow-up Questions
                            </h4>
                            <div style="display: flex; gap: 1rem; align-items: flex-start;">
                                <textarea id="followupQuestion" placeholder="Ask for clarification, specific strategies, or detailed explanations about any part of your analysis..." 
                                    style="flex: 1; min-height: 80px; padding: 0.75rem; border: 1px solid var(--border-color); border-radius: 6px; resize: vertical; font-family: inherit; font-size: 0.9rem;"></textarea>
                                <button onclick="app.askFollowupQuestion()" class="action-btn primary" style="padding: 0.75rem 1.5rem; white-space: nowrap;">
                                    <i class="fas fa-paper-plane"></i> Ask AI
                                </button>
                            </div>
                            <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.5rem;">
                                💡 Example: "Can you give me specific practice strategies for DILR?" or "Why did I score poorly in VARC despite good accuracy?"
                            </div>
                        </div>
                    </div>
                </div>
            `;
            
            // Replace the "Get AI Feedback" button in results-actions
            this.replaceAIFeedbackButton();
            
        } catch (error) {
            console.error('Error generating AI analysis:', error);
            document.querySelector('.analysis-content').innerHTML = `
                <div style="text-align: center; padding: 2rem;">
                    <i class="fas fa-exclamation-circle" style="font-size: 3rem; color: var(--danger-color); margin-bottom: 1rem;"></i>
                    <h3>Analysis Generation Failed</h3>
                    <p>Error: ${this.escapeHtml(error.message || 'Unknown error')}</p>
                    <p>Please try again later or check your connection.</p>
                    <button onclick="app.generateAIAnalysis()" class="btn btn-primary" style="margin-top: 1rem;">
                        <i class="fas fa-retry"></i> Retry Analysis
                    </button>
                </div>
            `;
        }
    }

    generateMarksDisplay(perfData) {
        return `
            <div style="background: linear-gradient(135deg, #2563eb, #7c3aed); 
                        color: white; padding: 2rem; border-radius: 8px; margin-bottom: 1rem; box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
                <h3 style="margin: 0 0 1rem 0; text-align: center; color: white; font-weight: 600;">
                    <i class="fas fa-trophy"></i> Your CAT Performance
                </h3>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1.5rem;">
                    <div style="text-align: center; background: rgba(255,255,255,0.2); padding: 1rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.3);">
                        <div style="font-size: 0.9rem; color: rgba(255,255,255,0.9);">VARC (Verbal)</div>
                        <div style="font-size: 1.5rem; font-weight: bold; color: white;">${perfData.section_scores.VARC}/${perfData.section_max_scores?.VARC || 72}</div>
                        <div style="font-size: 0.85rem; color: rgba(255,255,255,0.9);">${perfData.section_percentages.VARC}%</div>
                    </div>
                    <div style="text-align: center; background: rgba(255,255,255,0.2); padding: 1rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.3);">
                        <div style="font-size: 0.9rem; color: rgba(255,255,255,0.9);">DILR (Data & Logic)</div>
                        <div style="font-size: 1.5rem; font-weight: bold; color: white;">${perfData.section_scores.DILR}/${perfData.section_max_scores?.DILR || 60}</div>
                        <div style="font-size: 0.85rem; color: rgba(255,255,255,0.9);">${perfData.section_percentages.DILR}%</div>
                    </div>
                    <div style="text-align: center; background: rgba(255,255,255,0.2); padding: 1rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.3);">
                        <div style="font-size: 0.9rem; color: rgba(255,255,255,0.9);">QA (Quantitative)</div>
                        <div style="font-size: 1.5rem; font-weight: bold; color: white;">${perfData.section_scores.QA}/${perfData.section_max_scores?.QA || 66}</div>
                        <div style="font-size: 0.85rem; color: rgba(255,255,255,0.9);">${perfData.section_percentages.QA}%</div>
                    </div>
                </div>
                <div style="text-align: center; background: rgba(255,255,255,0.25); padding: 1rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.4);">
                    <div style="font-size: 1rem; color: rgba(255,255,255,0.9);">Total Score</div>
                    <div style="font-size: 2rem; font-weight: bold; color: white;">${perfData.total_score}/198</div>
                    <div style="font-size: 1rem; color: rgba(255,255,255,0.9);">${((perfData.total_score/198)*100).toFixed(1)}% Overall</div>
                </div>
            </div>
        `;
    }
    
    formatAnalysisText(text) {
        // First escape the text to prevent XSS, then convert markdown to HTML
        // This ensures that any existing HTML in the text is escaped first
        const escaped = this.escapeHtml(text);
        
        // Convert markdown-style formatting to HTML
        return escaped
            .replace(/## (.*?)$/gm, '<h4 style="color: var(--primary-color); margin: 1.5rem 0 0.5rem 0;">$1</h4>')
            .replace(/### (.*?)$/gm, '<h5 style="color: var(--text-color); margin: 1rem 0 0.5rem 0;">$1</h5>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/- (.*?)$/gm, '<li style="margin: 0.25rem 0;">$1</li>')
            .replace(/^\d+\. (.*?)$/gm, '<li style="margin: 0.25rem 0;">$1</li>')
            .split('\n').map(line => {
                if (line.trim().startsWith('<li>')) {
                    return line;
                } else if (line.trim().startsWith('<h')) {
                    return line;
                } else if (line.trim()) {
                    return `<p style="margin: 0.5rem 0;">${line}</p>`;
                }
                return '';
            }).join('');
    }

    async downloadProgress() {
        if (!this.currentUser) return;
        
        try {
            this.showLoading();
            
            // Download comprehensive PDF report from backend
            const response = await fetch(`/api/download-report/${this.currentUser.username}`, {
                method: 'GET'
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            // Get PDF blob
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            
            // Create download link
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            
            // Get filename from response headers or use default
            const contentDisposition = response.headers.get('content-disposition');
            let filename = `CAT_Progress_Report_${this.currentUser.username}_${new Date().toISOString().split('T')[0]}.pdf`;
            
            if (contentDisposition) {
                const filenameMatch = contentDisposition.match(/filename=([^;]+)/);
                if (filenameMatch) {
                    filename = filenameMatch[1].replace(/['"]/g, '');
                }
            }
            
            a.download = filename;
            
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
            
            this.showToast('Progress PDF report downloaded successfully!', 'success');
        } catch (error) {
            console.error('Error downloading PDF report:', error);
            this.showToast(`Failed to download PDF report: ${error.message}`, 'error');
        } finally {
            this.hideLoading();
        }
    }

    async downloadResults() {
        if (!this.currentUser) return;
        
        try {
            this.showLoading();
            
            // Download comprehensive PDF report from backend
            const response = await fetch(`/api/download-report/${this.currentUser.username}`, {
                method: 'GET'
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            // Get PDF blob
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            
            // Create download link
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            
            // Get filename from response headers or use default
            const contentDisposition = response.headers.get('content-disposition');
            let filename = `CAT_Test_Report_${this.currentUser.username}_${new Date().toISOString().split('T')[0]}.pdf`;
            
            if (contentDisposition) {
                const filenameMatch = contentDisposition.match(/filename=([^;]+)/);
                if (filenameMatch) {
                    filename = filenameMatch[1].replace(/['"]/g, '');
                }
            }
            
            a.download = filename;
            
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
            
            this.showToast('Comprehensive PDF report downloaded successfully!', 'success');
        } catch (error) {
            console.error('Error downloading PDF report:', error);
            this.showToast(`Failed to download PDF report: ${error.message}`, 'error');
        } finally {
            this.hideLoading();
        }
    }
    
    generateResultsCSV() {
        // Calculate current test statistics
        let totalAttempted = 0;
        let totalCorrect = 0;
        let totalMarks = 0;
        let sectionStats = { VARC: {attempted: 0, correct: 0, marks: 0}, DILR: {attempted: 0, correct: 0, marks: 0}, QA: {attempted: 0, correct: 0, marks: 0} };
        
        Object.keys(this.sectionQuestions).forEach(section => {
            const questions = this.sectionQuestions[section];
            questions.forEach(question => {
                const userAnswer = this.answers[question.id];
                if (userAnswer) {
                    totalAttempted++;
                    sectionStats[section].attempted++;
                    
                    if (userAnswer === question.answer) {
                        totalCorrect++;
                        sectionStats[section].correct++;
                        totalMarks += 3;
                        sectionStats[section].marks += 3;
                    } else if (question.question_type === 'Multiple Choice Question') {
                        totalMarks -= 1;
                        sectionStats[section].marks -= 1;
                    }
                }
            });
        });
        
        const timeSpent = 7200 - this.timeRemaining;
        const timeFormatted = this.formatTime(timeSpent);
        
        let csv = "CAT Mock Test Results Report\\n";
        csv += `Test Date,${new Date().toLocaleDateString()}\\n`;
        csv += `Student,${this.currentUser.name}\\n`;
        csv += `Username,${this.currentUser.username}\\n`;
        csv += "\\n";
        
        csv += "Overall Performance\\n";
        csv += "Metric,Value\\n";
        csv += `Total Questions Attempted,${totalAttempted}\\n`;
        csv += `Correct Answers,${totalCorrect}\\n`;
        csv += `Total Marks,${Math.max(0, totalMarks)}/198\\n`;
        csv += `Accuracy,${totalAttempted > 0 ? (totalCorrect/totalAttempted*100).toFixed(1) : 0}%\\n`;
        csv += `Time Taken,${timeFormatted}\\n`;
        // Safe substring for average time
        const avgTimeStr = totalAttempted > 0 ? this.formatTime(Math.floor(timeSpent/totalAttempted)) : '00:00:00';
        const avgTimeDisplay = avgTimeStr.length > 3 ? avgTimeStr.substring(3) : 'N/A';
        csv += `Average Time per Question,${totalAttempted > 0 ? avgTimeDisplay : 'N/A'}\\n`;
        csv += "\\n";
        
        csv += "Section-wise Performance\\n";
        csv += "Section,Questions Attempted,Correct Answers,Marks Obtained,Max Marks,Percentage,Accuracy\\n";
        
        Object.keys(sectionStats).forEach(section => {
            const stats = sectionStats[section];
            const sectionMax = stats.total * 3;
            const percentage = (Math.max(0, stats.marks) / sectionMax * 100).toFixed(1);
            const accuracy = stats.attempted > 0 ? (stats.correct / stats.attempted * 100).toFixed(1) : 0;
            
            csv += `${section},${stats.attempted},${stats.correct},${Math.max(0, stats.marks)},${sectionMax},${percentage}%,${accuracy}%\\n`;
        });
        
        csv += "\\n";
        csv += "Question-wise Details\\n";
        csv += "Section,Question ID,Your Answer,Correct Answer,Status,Marks,Bookmark,Flag\\n";
        
        Object.keys(this.sectionQuestions).forEach(section => {
            const questions = this.sectionQuestions[section];
            questions.forEach(question => {
                const userAnswer = this.answers[question.id] || 'Not Attempted';
                const status = userAnswer === 'Not Attempted' ? 'Skipped' : 
                             userAnswer === question.answer ? 'Correct' : 'Incorrect';
                const marks = userAnswer === 'Not Attempted' ? 0 : 
                            userAnswer === question.answer ? 3 :
                            question.question_type === 'Multiple Choice Question' ? -1 : 0;
                const bookmark = this.bookmarks.includes(question.id) ? 'Yes' : 'No';
                const flag = this.flags[question.id] || 'None';
                
                csv += `${section},${question.id},"${userAnswer}","${question.answer}",${status},${marks},${bookmark},${flag}\\n`;
            });
        });
        
        return csv;
    }
    
    replaceAIFeedbackButton() {
        // Replace the "Get AI Feedback" button with a disabled state after analysis is generated
        const aiButton = document.querySelector('button[onclick="generateAIFeedback()"]');
        if (aiButton) {
            aiButton.innerHTML = '<i class="fas fa-check"></i> Analysis Generated';
            aiButton.disabled = true;
            aiButton.style.opacity = '0.6';
            aiButton.style.cursor = 'not-allowed';
        }
    }
    
    async askFollowupQuestion() {
        const questionInput = document.getElementById('followupQuestion');
        const question = questionInput.value.trim();
        
        if (!question) {
            this.showToast('Please enter a follow-up question', 'warning');
            return;
        }
        
        if (!this.currentUser) {
            this.showToast('Please log in to ask follow-up questions', 'error');
            return;
        }
        
        try {
            // Show loading state
            const askButton = document.querySelector('button[onclick="app.askFollowupQuestion()"]');
            const originalContent = askButton.innerHTML;
            askButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Thinking...';
            askButton.disabled = true;
            
            // Send follow-up question to AI
            const response = await fetch('/api/ai-followup', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    username: this.currentUser.username,
                    question: question
                })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const followupData = await this.safeJsonParse(response);
            
            // Display the follow-up response
            this.displayFollowupResponse(question, followupData.response);
            
            // Clear the input
            questionInput.value = '';
            
            // Reset button
            askButton.innerHTML = originalContent;
            askButton.disabled = false;
            
        } catch (error) {
            console.error('Error with follow-up question:', error);
            this.showToast(`Failed to get AI response: ${error.message}`, 'error');
            
            // Reset button
            const askButton = document.querySelector('button[onclick="app.askFollowupQuestion()"]');
            askButton.innerHTML = '<i class="fas fa-paper-plane"></i> Ask AI';
            askButton.disabled = false;
        }
    }
    
    displayFollowupResponse(question, response) {
        // Find the analysis text container and add the follow-up Q&A
        const analysisContainer = document.querySelector('.analysis-text');
        if (analysisContainer) {
            const followupHtml = `
                <div style="margin-top: 2rem; padding: 1.5rem; background: rgba(0, 150, 136, 0.05); border-radius: 8px; border-left: 4px solid #009688;">
                    <div style="margin-bottom: 1rem;">
                        <h5 style="color: #009688; margin: 0 0 0.5rem 0;">
                            <i class="fas fa-user"></i> Your Question:
                        </h5>
                        <p style="margin: 0; font-style: italic; color: var(--text-color);">"${question}"</p>
                    </div>
                    <div>
                        <h5 style="color: var(--primary-color); margin: 0 0 0.5rem 0;">
                            <i class="fas fa-robot"></i> AI Response:
                        </h5>
                        <div style="color: var(--text-color); line-height: 1.6;">
                            ${this.formatAnalysisText(response)}
                        </div>
                    </div>
                </div>
            `;
            
            analysisContainer.insertAdjacentHTML('beforeend', followupHtml);
            
            // Scroll to the new response
            const newResponse = analysisContainer.lastElementChild;
            newResponse.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    async resumePausedTest(sessionId) {
        if (!confirm('Do you want to resume this paused test?')) {
            return;
        }

        this.showLoading();
        
        try {
            // Resume the test session
            const response = await fetch('/api/resume-test', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    session_id: sessionId
                })
            });

            if (!response.ok) {
                let errorData;
                try {
                    errorData = await this.safeJsonParse(response);
                } catch {
                    errorData = { detail: 'Failed to resume test' };
                }
                throw new Error(errorData.detail || 'Failed to resume test');
            }

            // Get the session data
            const sessionResponse = await fetch(`/api/session/${sessionId}`);
            if (!sessionResponse.ok) {
                throw new Error('Failed to load session data');
            }

            const sessionData = await this.safeJsonParse(sessionResponse);
            
            // Load test data
            const testResponse = await fetch(`/api/test-data/${sessionData.test_name}`);
            if (!testResponse.ok) {
                throw new Error('Failed to load test data');
            }
            
            this.testData = await this.safeJsonParse(testResponse);
            this.currentSession = sessionId;
            
            // Restore test state
            this.restoreTestState(sessionData);
            
            // Show test interface
            this.showPage('testPage');
            this.startTimer();
            this.startAutoSave();
            
            this.showToast('Test resumed successfully!', 'success');
        } catch (error) {
            console.error('Error resuming test:', error);
            this.showToast(`Failed to resume test: ${error.message}`, 'error');
        } finally {
            this.hideLoading();
        }
    }

    restoreTestState(sessionData) {
        // Restore all test state from session data        
        document.getElementById('testName').textContent = sessionData.test_name;
        
        // Reset button states to normal
        this.resetButtonStates();
        this.currentSection = sessionData.section;
        this.currentQuestionIndex = sessionData.question_index;
        
        // Convert backend answer format to frontend format
        // Backend: {question_id: {answer: 'b', correct_answer: 'c', ...}}
        // Frontend: {question_id: 'b'}
        this.answers = {};
        const backendAnswers = sessionData.answers || {};
        for (const questionId in backendAnswers) {
            const answerData = backendAnswers[questionId];
            const answer = answerData.answer || answerData;
            // Normalize answer - preserve numeric format, lowercase alphabetic
            if (answer && typeof answer !== 'undefined' && answer !== null) {
                const answerStr = String(answer).trim();
                if (/^\d+$/.test(answerStr)) {
                    // Numeric option: keep as string
                    this.answers[questionId] = answerStr;
                } else if (answerStr.length === 1 && /[a-zA-Z]/.test(answerStr)) {
                    // Single letter option: lowercase
                    this.answers[questionId] = answerStr.toLowerCase();
                } else {
                    // TITA or other format: keep as-is
                    this.answers[questionId] = answerStr;
                }
            }
        }
        
        this.bookmarks = sessionData.bookmarks || [];
        this.flags = sessionData.flags || {};
        // Ensure time_remaining is never negative
        this.timeRemaining = Math.max(0, sessionData.time_remaining || 7200);
        
        // If time has expired, show warning and prepare for auto-submit
        if (this.timeRemaining <= 0) {
            this.showToast('⚠️ Test time has expired. Submitting automatically...', 'warning');
            // Auto-submit after a short delay
            setTimeout(() => {
                if (!this.isSubmitting && this.currentSession) {
                    this.submitTest();
                }
            }, 2000);
        }
        
        // Flatten questions for easy navigation
        this.sectionQuestions = {
            'VARC': this.flattenQuestions(this.testData.VARC, 'VARC'),
            'DILR': this.flattenQuestions(this.testData.DILR, 'DILR'),
            'QA': this.flattenQuestions(this.testData.QA, 'QA')
        };
        
        // Update section tabs
        document.querySelectorAll('.section-tab').forEach(tab => {
            tab.classList.remove('active');
            if (tab.textContent.trim() === this.currentSection) {
                tab.classList.add('active');
            }
        });
        
        this.generateQuestionPalette();
        this.displayQuestion();
    }

    async returnToDashboard() {
        this.currentSession = null;
        this.showPage('dashboardPage');
        // Refresh all dashboard data when returning
        await this.loadAvailableTests();
        await this.loadUserProgress();
        await this.checkForPausedTests();
    }
}

// Authentication tab switching
function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.auth-form').forEach(form => form.classList.remove('active'));
    
    event.target.classList.add('active');
    document.getElementById(tab + 'Form').classList.add('active');
}

// Global functions for HTML onclick handlers
function handleSignup(event) {
    app.handleSignup(event);
}

function handleLogin(event) {
    app.handleLogin(event);
}

function logout() {
    app.logout();
}

function downloadProgress() {
    app.downloadProgress();
}

function pauseTest() {
    app.pauseTest();
}

function saveTest() {
    app.saveTest();
}

function submitTest() {
    app.submitTest();
}

function switchSection(section) {
    app.switchSection(section);
}

function toggleDarkMode() {
    app.toggleDarkMode();
}

function previousQuestion() {
    app.previousQuestion();
}

function nextQuestion() {
    app.nextQuestion();
}

function toggleBookmark() {
    app.toggleBookmark();
}

function toggleFlagMenu() {
    app.toggleFlagMenu();
}

function setFlag(color) {
    app.setFlag(color);
}

function generateAIFeedback() {
    app.generateAIFeedback();
}

function downloadResults() {
    app.downloadResults();
}

function returnToDashboard() {
    app.returnToDashboard();
}

// Initialize the app
const app = new CATMockTestApp();

