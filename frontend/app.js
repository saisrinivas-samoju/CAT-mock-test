// CAT Mock Test Portal - JavaScript Application
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
        this.sectionQuestions = {
            'VARC': [],
            'DILR': [],
            'QA': []
        };
        
        this.init();
    }

    async init() {
        // Check if user is already logged in
        const savedUser = localStorage.getItem('catUser');
        if (savedUser) {
            this.currentUser = JSON.parse(savedUser);
            
            // Check for page refresh recovery first
            const recovered = await this.checkForPageRefreshRecovery();
            
            if (!recovered) {
                this.showPage('dashboardPage');
                await this.loadDashboard();
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
                const sessionData = await response.json();
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
            this.currentSession = sessionData.session_id;
            
            // Load test data
            const testResponse = await fetch(`/api/test-data/${sessionData.test_name}`);
            if (!testResponse.ok) {
                throw new Error('Failed to load test data');
            }
            const testData = await testResponse.json();
            
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
                    this.answers[questionId] = answerData.answer;
                }
            });
            
            this.bookmarks = sessionData.bookmarks || [];
            this.flags = sessionData.flags || {};
            this.currentSection = sessionData.section || 'VARC';
            this.currentQuestionIndex = sessionData.question_index || 0;
            this.timeRemaining = sessionData.time_remaining || 7200;
            
            // Set test name for display
            document.getElementById('testName').textContent = sessionData.test_name;
            
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
        const submitButtons = document.querySelectorAll('[onclick*="submitTest"]');
        submitButtons.forEach(btn => {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit';
        });
        
        // Reset other control buttons if needed
        const saveButtons = document.querySelectorAll('[onclick*="saveTest"]');
        saveButtons.forEach(btn => {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-save"></i> Save';
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
            if (this.currentSession) {
                this.saveSession();
            }
        });
    }

    // Utility Functions
    showPage(pageId) {
        document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
        document.getElementById(pageId).classList.add('active');
    }

    showLoading() {
        document.getElementById('loadingOverlay').classList.add('active');
    }

    hideLoading() {
        document.getElementById('loadingOverlay').classList.remove('active');
    }

    showToast(message, type = 'info') {
        const toastContainer = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        
        const icon = {
            'success': 'fa-check-circle',
            'error': 'fa-exclamation-circle',
            'warning': 'fa-exclamation-triangle',
            'info': 'fa-info-circle'
        }[type];
        
        toast.innerHTML = `
            <i class="fas ${icon}"></i>
            <span>${message}</span>
        `;
        
        toastContainer.appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 100);
        
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toastContainer.removeChild(toast), 300);
        }, 3000);
    }

    formatTime(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
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

            const data = await response.json();

            if (response.ok) {
                this.showToast('Account created successfully!', 'success');
                this.currentUser = { username: data.username, name: data.name };
                localStorage.setItem('catUser', JSON.stringify(this.currentUser));
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

            const data = await response.json();

            if (response.ok) {
                this.showToast(`Welcome back, ${data.name}!`, 'success');
                this.currentUser = { username: data.username, name: data.name };
                localStorage.setItem('catUser', JSON.stringify(this.currentUser));
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

    logout() {
        localStorage.removeItem('catUser');
        this.currentUser = null;
        this.currentSession = null;
        if (this.timerInterval) clearInterval(this.timerInterval);
        if (this.autoSaveInterval) clearInterval(this.autoSaveInterval);
        this.showPage('authPage');
        this.showToast('Logged out successfully', 'info');
    }

    // Dashboard Functions
    async loadDashboard() {
        document.getElementById('userGreeting').textContent = `Welcome, ${this.currentUser.name}!`;
        await this.loadAvailableTests();
        await this.loadUserProgress();
        await this.checkForPausedTests();
    }

    async checkForPausedTests() {
        try {
            const response = await fetch(`/api/paused-tests/${this.currentUser.username}`);
            
            if (response.ok) {
                const pausedTests = await response.json();
                
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
                const stats = await response.json();
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

    updateProgressDisplay(stats) {
        // Update total time
        const hours = Math.floor(stats.total_time / 3600);
        const minutes = Math.floor((stats.total_time % 3600) / 60);
        document.getElementById('totalTime').textContent = `${hours}h ${minutes}m`;
        
        // Update tests completed
        document.getElementById('testsCompleted').textContent = stats.tests_completed || stats.total_attempts || 0;
        
        // Update average score
        const avgScore = stats.average_score || 0;
        document.getElementById('avgScore').textContent = `${Math.round(avgScore)}%`;
    }

    async loadAvailableTests() {
        try {
            const response = await fetch('/api/tests');
            const tests = await response.json();
            
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
                const errorData = await sessionResponse.json();
                throw new Error(errorData.detail || 'Failed to start test session');
            }
            
            const sessionData = await sessionResponse.json();
            this.currentSession = sessionData.session_id;

            // Load test data
            const testResponse = await fetch(`/api/test-data/${testName}`);
            if (!testResponse.ok) {
                const errorData = await testResponse.json();
                throw new Error(errorData.detail || 'Failed to load test data');
            }
            this.testData = await testResponse.json();
            
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
        document.getElementById('testName').textContent = testName;
        
        // Reset all test state
        this.currentSection = 'VARC';
        this.currentQuestionIndex = 0;
        this.answers = {};
        this.bookmarks = [];
        this.flags = {};
        this.timeRemaining = 7200;
        
        // Flatten questions for easy navigation
        this.sectionQuestions = {
            'VARC': this.flattenQuestions(this.testData.VARC, 'VARC'),
            'DILR': this.flattenQuestions(this.testData.DILR, 'DILR'),
            'QA': this.flattenQuestions(this.testData.QA, 'QA')
        };
        
        console.log('Section questions:', {
            VARC: this.sectionQuestions.VARC.length,
            DILR: this.sectionQuestions.DILR.length,
            QA: this.sectionQuestions.QA.length
        });
        
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
        
        sectionData.forEach(questionObj => {
            questionObj.qa_list.forEach(qa => {
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
                    answer: qa.answer,
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
        const currentQuestions = this.sectionQuestions[this.currentSection];
        
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
        
        buttons.forEach((btn, index) => {
            const question = currentQuestions[index];
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
        const question = currentQuestions[this.currentQuestionIndex];
        
        if (!question) return;

        // Update section indicator
        document.getElementById('currentSection').textContent = this.currentSection;
        
        // Update question number
        document.getElementById('questionNumber').textContent = 
            `Question ${this.currentQuestionIndex + 1} of ${currentQuestions.length}`;
        
        // Update navigation buttons
        const prevBtn = document.querySelector('.nav-btn:first-child');
        const nextBtn = document.querySelector('.nav-btn:last-child');
        
        prevBtn.disabled = this.currentQuestionIndex === 0;
        nextBtn.disabled = this.currentQuestionIndex === currentQuestions.length - 1 && 
                          this.currentSection === 'QA';
        
        // Display context with image support
        const contextArea = document.getElementById('questionContext');
        let contextContent = '';
        
        // Add image if available
        if (question.image_source) {
            const imagePath = question.image_source.replace('input/images/', '/static/images/');
            contextContent += `
                <div class="question-image" style="text-align: center; margin-bottom: 1rem;">
                    <img src="${imagePath}" 
                         alt="Question diagram" 
                         style="max-width: 100%; height: auto; border: 1px solid var(--border-color); border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);"
                         onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
                    <div style="display: none; padding: 1rem; background: #fff3cd; color: #856404; border: 1px solid #ffeaa7; border-radius: 4px; margin-top: 0.5rem;">
                        <i class="fas fa-exclamation-triangle"></i> Image not available: ${question.image_source.split('/').pop()}
                    </div>
                </div>
            `;
        }
        
        // Add context text
        if (question.context && question.context.trim()) {
            contextContent += question.context;
        }
        
        if (contextContent.trim()) {
            contextArea.innerHTML = contextContent;
            contextArea.style.display = 'block';
        } else {
            contextArea.style.display = 'none';
        }
        
        // Display question text
        document.querySelector('.question-text').innerHTML = question.question;
        
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
        
        if (question.question_type === 'Multiple Choice Question' && question.options) {
            // MCQ options
            optionsContainer.innerHTML = question.options.map(option => {
                const optionLetter = option.charAt(0);
                const isSelected = this.answers[question.id] === optionLetter;
                
                return `
                    <div class="option ${isSelected ? 'selected' : ''}" onclick="app.selectOption('${question.id}', '${optionLetter}')">
                        <input type="radio" name="answer" value="${optionLetter}" ${isSelected ? 'checked' : ''}>
                        <span>${option}</span>
                    </div>
                `;
            }).join('');
        } else {
            // TITA input
            const currentAnswer = this.answers[question.id] || '';
            
            optionsContainer.innerHTML = `
                <input type="text" class="tita-input" placeholder="Enter your answer" 
                       value="${currentAnswer}" onchange="app.setTITAAnswer('${question.id}', this.value)">
            `;
        }
    }

    selectOption(questionId, optionLetter) {
        this.answers[questionId] = optionLetter;
        
        // Update UI - remove selected class from all options
        document.querySelectorAll('.option').forEach(option => {
            option.classList.remove('selected');
            const radioInput = option.querySelector('input[type="radio"]');
            if (radioInput) {
                radioInput.checked = false;
            }
        });
        
        // Add selected class and check radio button for current option
        event.currentTarget.classList.add('selected');
        const radioInput = event.currentTarget.querySelector('input[type="radio"]');
        if (radioInput) {
            radioInput.checked = true;
        }
        
        // Submit answer
        this.submitAnswer(questionId, optionLetter);
        
        // Update palette
        this.updatePaletteStatus();
    }

    setTITAAnswer(questionId, value) {
        this.answers[questionId] = value.trim();
        this.submitAnswer(questionId, value.trim());
        this.updatePaletteStatus();
    }

    async submitAnswer(questionId, answer) {
        const timeSpent = this.questionStartTime ? 
            Math.floor((Date.now() - this.questionStartTime) / 1000) : 0;
        
        try {
            await fetch('/api/submit-answer', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    session_id: this.currentSession,
                    question_id: questionId,
                    answer: answer,
                    time_spent: timeSpent
                })
            });
        } catch (error) {
            console.error('Error submitting answer:', error);
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

    // MathJax rendering helper
    renderMathJax() {
        try {
            if (window.MathJax) {
                if (MathJax.typesetPromise) {
                    // MathJax v3 API
                    MathJax.typesetPromise([document.getElementById('questionBody')]).catch((err) => {
                        console.warn('MathJax rendering error:', err);
                    });
                } else if (MathJax.Hub && MathJax.Hub.Queue) {
                    // MathJax v2 API fallback
                    MathJax.Hub.Queue(["Typeset", MathJax.Hub, "questionBody"]);
                } else if (MathJax.typeset) {
                    // Alternative v3 API
                    MathJax.typeset([document.getElementById('questionBody')]);
                }
            }
        } catch (error) {
            console.warn('MathJax not available or error rendering:', error);
        }
    }

    // Navigation Functions
    navigateToQuestion(index) {
        this.currentQuestionIndex = index;
        this.displayQuestion();
    }

    previousQuestion() {
        if (this.currentQuestionIndex > 0) {
            this.currentQuestionIndex--;
            this.displayQuestion();
        }
    }

    nextQuestion() {
        const currentQuestions = this.sectionQuestions[this.currentSection];
        
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
        const question = currentQuestions[this.currentQuestionIndex];
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
        this.timerInterval = setInterval(() => {
            this.timeRemaining--;
            document.getElementById('timeRemaining').textContent = this.formatTime(this.timeRemaining);
            
            // Time warnings
            if (this.timeRemaining === 600) { // 10 minutes
                this.showToast('10 minutes remaining!', 'warning');
            } else if (this.timeRemaining === 300) { // 5 minutes
                this.showToast('5 minutes remaining!', 'warning');
            } else if (this.timeRemaining === 60) { // 1 minute
                this.showToast('1 minute remaining!', 'warning');
            } else if (this.timeRemaining <= 0) {
                this.submitTest();
            }
        }, 1000);
    }

    startAutoSave() {
        this.autoSaveInterval = setInterval(() => {
            this.saveSession();
        }, 30000); // Auto-save every 30 seconds
    }

    // Session Management
    async saveSession() {
        if (!this.currentSession) return;
        
        try {
            await fetch('/api/save-session', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    session_id: this.currentSession
                })
            });
        } catch (error) {
            console.error('Error saving session:', error);
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
        await this.saveSession();
        this.showToast('Test progress saved successfully!', 'success');
    }

    async submitTest() {
        if (!confirm('Are you sure you want to submit the test? This action cannot be undone.')) {
            return;
        }
        
        // Disable submit button to prevent double-clicks
        const submitButtons = document.querySelectorAll('[onclick*="submitTest"]');
        submitButtons.forEach(btn => {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting...';
        });
        
        try {
            if (this.timerInterval) clearInterval(this.timerInterval);
            if (this.autoSaveInterval) clearInterval(this.autoSaveInterval);
            
            // Save session with timeout protection
            const savePromise = this.saveSession();
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Save timeout')), 10000) // 10 second timeout
            );
            
            try {
                await Promise.race([savePromise, timeoutPromise]);
            } catch (error) {
                console.warn('Save session timeout, proceeding with submit:', error);
                // Continue with submission even if save times out
            }
            
            // Calculate results
            this.calculateResults();
            
            // Show results page
            this.showPage('resultsPage');
            this.showToast('Test submitted successfully!', 'success');
            
            // Clear current session to prevent confusion with next test
            this.currentSession = null;
            
            // Force refresh progress when test is completed
            setTimeout(() => {
                if (this.currentUser) {
                    this.loadUserProgress();
                }
            }, 1000);
            
        } catch (error) {
            console.error('Error submitting test:', error);
            this.showToast('Error submitting test. Please try again.', 'error');
            
            // Re-enable submit button
            submitButtons.forEach(btn => {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit';
            });
        }
    }

    calculateResults() {
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
        Object.keys(this.sectionQuestions).forEach(section => {
            const questions = this.sectionQuestions[section];
            let sectionMarks = 0;
            
            // Set actual total for this section
            sectionStats[section].total = questions.length;
            totalQuestions += questions.length;
            
            questions.forEach(question => {
                const userAnswer = this.answers[question.id];
                
                // Only count questions that were actually answered (not empty/null)
                if (userAnswer && userAnswer.trim() !== '') {
                    sectionStats[section].attempted++;
                    totalAttempted++;
                    
                    if (userAnswer.toLowerCase() === question.answer.toLowerCase()) {
                        sectionStats[section].correct++;
                        correctAnswers++;
                        sectionMarks += 3; // +3 for correct answer
                    } else if (question.question_type === 'Multiple Choice Question') {
                        sectionMarks -= 1; // -1 for wrong MCQ answer
                    }
                    // TITA wrong answers get 0 marks (no negative marking)
                }
            });
            
            sectionStats[section].marks = sectionMarks; // Allow negative marks for sections
            sectionScores[section] = sectionStats[section].marks;
            totalScore += sectionStats[section].marks;
        });
        
        // Update basic results display
        document.getElementById('totalScore').textContent = totalScore;
        document.getElementById('varcScore').textContent = `${sectionScores.VARC}/72`;
        document.getElementById('dilrScore').textContent = `${sectionScores.DILR}/60`;
        document.getElementById('qaScore').textContent = `${sectionScores.QA}/66`;
        document.getElementById('accuracyPercent').textContent = 
            `${Math.round((correctAnswers / totalAttempted) * 100)}%`;
        
        // Calculate time spent
        const timeSpent = 7200 - this.timeRemaining;
        document.getElementById('totalTimeSpent').textContent = this.formatTime(timeSpent);
        document.getElementById('avgTimePerQ').textContent = 
            this.formatTime(Math.floor(timeSpent / totalAttempted)).substring(3); // Remove hours
            
        // Update detailed breakdown
        this.displayDetailedResults(sectionStats, totalAttempted, correctAnswers, totalScore);
    }
    
    displayDetailedResults(sectionStats, totalAttempted, correctAnswers, totalScore) {
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
                            <div style="font-size: 1.8rem; font-weight: bold; color: white;">${Math.round((correctAnswers/totalAttempted)*100)}%</div>
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
                        const maxMarks = section === 'VARC' ? 72 : section === 'DILR' ? 60 : 66;
                        
                        return `
                        <div style="background: white; border: 1px solid var(--border-color); border-radius: 8px; padding: 1rem;">
                            <h5 style="color: var(--primary-color); margin: 0 0 1rem 0; text-align: center;">${sectionName}</h5>
                            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem; font-size: 0.9rem;">
                                <div><strong>Total Questions:</strong> ${stats.total}</div>
                                <div><strong>Attempted:</strong> ${stats.attempted}</div>
                                <div><strong>Correct:</strong> ${stats.correct}</div>
                                <div><strong>Accuracy:</strong> ${accuracy}%</div>
                                <div style="grid-column: span 2; margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border-color);">
                                    <strong style="color: var(--primary-color);">Marks: ${stats.marks}/${maxMarks}</strong>
                                </div>
                            </div>
                        </div>
                        `;
                    }).join('')}
                </div>
                
                <!-- Answered Questions Table -->
                <div style="margin-top: 1.5rem; background: white; border: 1px solid var(--border-color); border-radius: 8px; padding: 1rem;">
                    <h4 style="color: var(--primary-color); margin: 0 0 1rem 0;">
                        <i class="fas fa-list-alt"></i> Answered Questions Details
                    </h4>
                    <div id="answeredQuestionsTable">
                        <!-- Table will be populated by displayAnsweredQuestionsTable -->
                    </div>
                </div>
            </div>
        `;
        
        // Insert after the results grid
        const resultsGrid = document.querySelector('.results-grid');
        let existingBreakdown = document.querySelector('.detailed-results-breakdown');
        if (existingBreakdown) {
            existingBreakdown.remove();
        }
        resultsGrid.insertAdjacentHTML('afterend', detailedBreakdown);
        
        // Populate the answered questions table
        this.displayAnsweredQuestionsTable();
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
            if (!answer || answer.trim() === '' || answer === null || answer === undefined) {
                return; // Skip unanswered questions
            }
            
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
                const isCorrect = answer.toLowerCase() === questionData.answer.toLowerCase();
                const marks = isCorrect ? 3 : (questionData.question_type === 'Multiple Choice Question' ? -1 : 0);
                
                answeredQuestions.push({
                    questionId: questionId,
                    section: section,
                    questionText: this.cleanHtmlText(questionData.question).substring(0, 100) + '...',
                    userAnswer: answer,
                    correctAnswer: questionData.answer,
                    isCorrect: isCorrect,
                    marks: marks,
                    questionType: questionData.question_type
                });
            }
        });

        if (answeredQuestions.length === 0) {
            tableContainer.innerHTML = '<p style="text-align: center; color: #718096; font-style: italic; padding: 2rem;">No questions were answered in this test.</p>';
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
                            const rowBg = index % 2 === 0 ? 'var(--surface-color)' : 'white';
                            const statusIcon = q.isCorrect ? '✅' : '❌';
                            const statusText = q.isCorrect ? 'Correct' : 'Incorrect';
                            const statusColor = q.isCorrect ? '#10b981' : '#ef4444';
                            const marksColor = q.marks > 0 ? '#10b981' : q.marks < 0 ? '#ef4444' : '#6b7280';
                            
                            return `
                                <tr style="background: ${rowBg}; border-bottom: 1px solid var(--border-color);">
                                    <td style="padding: 12px; border-right: 1px solid var(--border-color); vertical-align: top;">
                                        <span style="background: var(--primary-color); color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.8rem; font-weight: bold;">${q.section}</span>
                                    </td>
                                    <td style="padding: 12px; border-right: 1px solid var(--border-color); max-width: 300px; color: var(--text-color); font-size: 0.9rem; vertical-align: top;">
                                        ${q.questionText}
                                    </td>
                                    <td style="padding: 12px; text-align: center; border-right: 1px solid var(--border-color); vertical-align: top;">
                                        <span style="background: #dbeafe; color: #1d4ed8; padding: 6px 12px; border-radius: 6px; font-weight: bold; font-size: 1rem;">${q.userAnswer.toUpperCase()}</span>
                                    </td>
                                    <td style="padding: 12px; text-align: center; border-right: 1px solid var(--border-color); vertical-align: top;">
                                        <span style="background: #dcfce7; color: #16a34a; padding: 6px 12px; border-radius: 6px; font-weight: bold; font-size: 1rem;">${q.correctAnswer.toUpperCase()}</span>
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
        // Create a temporary element to strip HTML tags
        const temp = document.createElement('div');
        temp.innerHTML = html;
        return temp.textContent || temp.innerText || '';
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
            
            const analysisData = await response.json();
            
            if (analysisData.status === 'unavailable') {
                document.querySelector('.analysis-content').innerHTML = `
                    <div style="padding: 2rem;">
                        <div style="text-align: center; margin-bottom: 2rem;">
                            <i class="fas fa-exclamation-triangle" style="font-size: 3rem; color: var(--warning-color); margin-bottom: 1rem;"></i>
                            <h3>AI Analysis Unavailable</h3>
                            <p>${analysisData.message}</p>
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
                    <p>Error: ${error.message}</p>
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
                        <div style="font-size: 1.5rem; font-weight: bold; color: white;">${perfData.section_scores.VARC}/72</div>
                        <div style="font-size: 0.85rem; color: rgba(255,255,255,0.9);">${perfData.section_percentages.VARC}%</div>
                    </div>
                    <div style="text-align: center; background: rgba(255,255,255,0.2); padding: 1rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.3);">
                        <div style="font-size: 0.9rem; color: rgba(255,255,255,0.9);">DILR (Data & Logic)</div>
                        <div style="font-size: 1.5rem; font-weight: bold; color: white;">${perfData.section_scores.DILR}/60</div>
                        <div style="font-size: 0.85rem; color: rgba(255,255,255,0.9);">${perfData.section_percentages.DILR}%</div>
                    </div>
                    <div style="text-align: center; background: rgba(255,255,255,0.2); padding: 1rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.3);">
                        <div style="font-size: 0.9rem; color: rgba(255,255,255,0.9);">QA (Quantitative)</div>
                        <div style="font-size: 1.5rem; font-weight: bold; color: white;">${perfData.section_scores.QA}/66</div>
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
        // Convert markdown-style formatting to HTML
        return text
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
            const response = await fetch(`/api/user-progress/${this.currentUser.username}`);
            
            if (response.ok) {
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${this.currentUser.username}_progress.xlsx`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                window.URL.revokeObjectURL(url);
                
                this.showToast('Progress report downloaded successfully!', 'success');
            } else {
                this.showToast('No progress data available', 'info');
            }
        } catch (error) {
            console.error('Error downloading progress:', error);
            this.showToast('Failed to download progress report', 'error');
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
        csv += `Average Time per Question,${totalAttempted > 0 ? this.formatTime(Math.floor(timeSpent/totalAttempted)).substring(3) : 'N/A'}\\n`;
        csv += "\\n";
        
        csv += "Section-wise Performance\\n";
        csv += "Section,Questions Attempted,Correct Answers,Marks Obtained,Max Marks,Percentage,Accuracy\\n";
        
        const maxMarks = {VARC: 72, DILR: 60, QA: 66};
        Object.keys(sectionStats).forEach(section => {
            const stats = sectionStats[section];
            const sectionMax = maxMarks[section];
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
            
            const followupData = await response.json();
            
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
                const errorData = await response.json();
                throw new Error(errorData.detail || 'Failed to resume test');
            }

            // Get the session data
            const sessionResponse = await fetch(`/api/session/${sessionId}`);
            if (!sessionResponse.ok) {
                throw new Error('Failed to load session data');
            }

            const sessionData = await sessionResponse.json();
            
            // Load test data
            const testResponse = await fetch(`/api/test-data/${sessionData.test_name}`);
            if (!testResponse.ok) {
                throw new Error('Failed to load test data');
            }
            
            this.testData = await testResponse.json();
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
            this.answers[questionId] = answerData.answer || answerData;
        }
        
        this.bookmarks = sessionData.bookmarks || [];
        this.flags = sessionData.flags || {};
        this.timeRemaining = sessionData.time_remaining;
        
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

