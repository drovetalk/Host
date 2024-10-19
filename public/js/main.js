// Theme handling
const themeToggle = document.getElementById('themeToggle');
const root = document.documentElement;

function setTheme(theme) {
    root.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    themeToggle.innerHTML = theme === 'dark' 
        ? '<i class="fas fa-sun"></i>' 
        : '<i class="fas fa-moon"></i>';
}

// Initialize theme
document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme);
});

themeToggle.addEventListener('click', () => {
    const currentTheme = root.getAttribute('data-theme');
    setTheme(currentTheme === 'dark' ? 'light' : 'dark');
});

// Notification handling
function showNotification(message, type = 'success') {
    const notification = document.querySelector(`.${type}`);
    notification.textContent = message;
    notification.style.display = 'block';
    
    setTimeout(() => {
        notification.style.display = 'none';
    }, 3000);
}

// Loading screen
function initializeLoadingScreen() {
    const loadingText = document.getElementById('loading-text');
    const messages = ['Loading', 'Loading.', 'Loading..', 'Loading...'];
    let currentIndex = 0;

    const interval = setInterval(() => {
        loadingText.textContent = messages[currentIndex];
        currentIndex = (currentIndex + 1) % messages.length;
    }, 300);

    setTimeout(() => {
        clearInterval(interval);
        document.getElementById('loading-screen').style.display = 'none';
    }, 1500);
}

// Coins handling
async function updateCoinBalance() {
    try {
        const response = await fetch('/user-coins');
        const data = await response.json();
        document.getElementById('coinBalance').textContent = `${data.coins} Coins`;
    } catch (error) {
        console.error('Error fetching coin balance:', error);
        showNotification('Failed to update coin balance', 'error');
    }
}

document.getElementById('claimCoinsBtn').addEventListener('click', async () => {
    try {
        const response = await fetch('/claim-coins', { method: 'POST' });
        const data = await response.json();

        if (response.ok) {
            showNotification(data.message);
            updateCoinBalance();
        } else {
            throw new Error(data.message);
        }
    } catch (error) {
        showNotification(error.message, 'error');
    }
});

// Apps handling
async function fetchUserApps() {
    const loader = document.getElementById('loader');
    loader.style.display = 'block';

    try {
        const response = await fetch('/user-apps');
        if (!response.ok) throw new Error('Failed to load bots');
        
        const apps = await response.json();
        displayUserApps(apps);
    } catch (error) {
        showNotification(error.message, 'error');
    } finally {
        loader.style.display = 'none';
    }
}

function displayUserApps(apps) {
    const userAppsDiv = document.getElementById('userApps');
    
    if (apps.length === 0) {
        userAppsDiv.innerHTML = `
            <div class="app-item" style="text-align: center;">
                <p>You haven't deployed any bots yet...</p>
            </div>
        `;
        return;
    }

    userAppsDiv.innerHTML = apps.map(app => `
        <div class="app-item" onclick="window.location.href='/app-details/${app.app_name}'">
            <div class="app-header">
                <h3 class="app-name">${app.app_name}</h3>
                <div class="app-status"></div>
            </div>
        </div>
    `).join('');
}

// Authentication
async function checkLogin() {
    try {
        const response = await fetch('/check-login');
        if (!response.ok) window.location.href = '/login';
    } catch (error) {
        showNotification('Authentication error', 'error');
    }
}

// Logout handling
document.getElementById('logoutBtn').addEventListener('click', async () => {
    try {
        const response = await fetch('/logout');
        if (response.ok) window.location.href = '/login';
        else throw new Error('Logout failed');
    } catch (error) {
        showNotification('Logout failed', 'error');
    }
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initializeLoadingScreen();
    checkLogin();
    fetchUserApps();
    updateCoinBalance();
});