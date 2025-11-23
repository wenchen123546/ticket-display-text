const socket = io();
let token = localStorage.getItem('token');
let currentQueues = [];
let activeQueueId = null;
let userRole = '';

// --- Login / Init ---
if (token) init();

async function login() {
    const u = document.getElementById('username').value;
    const p = document.getElementById('password').value;
    try {
        const res = await fetch('/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, password: p })
        });
        const data = await res.json();
        if (data.success) {
            token = data.token;
            localStorage.setItem('token', token);
            userRole = data.role;
            init();
        } else {
            document.getElementById('login-msg').textContent = data.error;
        }
    } catch (e) { alert("Login failed"); }
}

function logout() {
    localStorage.removeItem('token');
    location.reload();
}

async function init() {
    document.getElementById('login-overlay').style.display = 'none';
    document.getElementById('admin-panel').style.display = 'block';
    
    // Fetch initial data
    const res = await fetch('/api/init-data', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
    });
    const data = await res.json();
    if(data.success) {
        if(userRole === 'super') document.getElementById('super-admin-area').style.display = 'block';
        
        // Sync Settings
        document.getElementById('toggle-multi-queue').checked = data.settings.multi_queue_enabled === '1';
        document.getElementById('toggle-public').checked = data.settings.is_public === '1';
    }
}

// --- Socket Events ---
socket.on("updateState", (data) => {
    currentQueues = data.queues;
    renderQueueSelect(data.isMulti);
    renderQueueList(data.queues); // For Super Admin
    
    if(!activeQueueId && currentQueues.length > 0) {
        activeQueueId = currentQueues[0].id;
    }
    updateUI();
});

socket.on("updatePassed", (data) => {
    if(activeQueueId === data.queueId) {
        renderPassed(data.numbers);
    }
});

socket.on("newAdminLog", (msg) => {
    const ul = document.getElementById('log-list');
    const li = document.createElement('li');
    li.textContent = msg;
    ul.prepend(li);
});

// --- UI Logic ---
function renderQueueSelect(isMulti) {
    const sel = document.getElementById('queue-select');
    sel.innerHTML = '';
    
    if(!isMulti && currentQueues.length > 0) {
        // If multi-queue disabled, just use the first one logically but hide selector
        document.getElementById('queue-selector-container').style.display = 'none';
        activeQueueId = currentQueues[0].id;
    } else {
        document.getElementById('queue-selector-container').style.display = 'block';
        currentQueues.forEach(q => {
            const opt = document.createElement('option');
            opt.value = q.id;
            opt.textContent = `${q.name} (${q.current_num})`;
            sel.appendChild(opt);
        });
        sel.value = activeQueueId;
    }
}

document.getElementById('queue-select').addEventListener('change', (e) => {
    activeQueueId = parseInt(e.target.value);
    updateUI();
});

function updateUI() {
    const queue = currentQueues.find(q => q.id === activeQueueId);
    if(queue) {
        document.getElementById('admin-number').textContent = queue.current_num;
        document.getElementById('admin-prefix').textContent = queue.prefix;
    }
}

function renderPassed(numbers) {
    const ul = document.getElementById('admin-passed-list');
    ul.innerHTML = '';
    numbers.forEach(n => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${n}</span> <button onclick="removePassed(${n})">×</button>`;
        ul.appendChild(li);
    });
}

// --- API Calls ---
async function apiCall(endpoint, body) {
    await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, ...body })
    });
}

function changeNum(direction) {
    apiCall('/api/admin/write/change-number', { direction, queueId: activeQueueId });
}

function setNum() {
    const val = document.getElementById('manual-num').value;
    if(val) apiCall('/api/admin/write/change-number', { setNumber: val, queueId: activeQueueId });
    document.getElementById('manual-num').value = '';
}

function addPassed() {
    const val = document.getElementById('passed-input').value;
    if(val) apiCall('/api/admin/write/passed', { action: 'add', number: val, queueId: activeQueueId });
    document.getElementById('passed-input').value = '';
}

function removePassed(n) {
    apiCall('/api/admin/write/passed', { action: 'remove', number: n, queueId: activeQueueId });
}

function clearPassed() {
    if(confirm("確定清空?")) apiCall('/api/admin/write/passed', { action: 'clear', queueId: activeQueueId });
}

// Super Admin
function toggleSetting(key, checked) {
    apiCall('/api/admin/write/settings', { key, value: checked });
}

function createQueue() {
    const name = document.getElementById('new-queue-name').value;
    const prefix = document.getElementById('new-queue-prefix').value;
    if(name) apiCall('/api/super/manage-queue', { action: 'create', name, prefix });
}

function deleteQueue(id) {
    if(confirm("刪除此佇列?")) apiCall('/api/super/manage-queue', { action: 'delete', id });
}

function renderQueueList(queues) {
    const ul = document.getElementById('queue-list');
    ul.innerHTML = '';
    queues.forEach(q => {
        const li = document.createElement('li');
        li.innerHTML = `${q.name} [${q.prefix}] <button onclick="deleteQueue(${q.id})">刪除</button>`;
        ul.appendChild(li);
    });
}
