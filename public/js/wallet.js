document.addEventListener('DOMContentLoaded', () => {
    loadWalletInfo();

    document.getElementById('sendCoinsBtn').addEventListener('click', sendCoins);
    document.getElementById('depositCoinsBtn').addEventListener('click', depositCoins);
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);
    document.getElementById('logoutBtn').addEventListener('click', logout);
});

async function loadWalletInfo() {
    try {
        const response = await fetch('/api/wallet');
        const data = await response.json();

        document.getElementById('coinBalance').textContent = data.coins;
        document.getElementById('totalDeployments').textContent = data.deployments.count;
        document.getElementById('totalSpent').textContent = data.deployments.total_cost;

        const transactionList = document.getElementById('transactionList');
        transactionList.innerHTML = '';
        data.recentTransactions.forEach(transaction => {
            const li = document.createElement('li');
            li.textContent = `${transaction.transaction_type}: ${transaction.amount} coins - ${new Date(transaction.transaction_date).toLocaleString()}`;
            transactionList.appendChild(li);
        });
    } catch (error) {
        console.error('Error loading wallet info:', error);
    }
}

async function sendCoins() {
    const recipientPhone = document.getElementById('recipientPhone').value;
    const amount = parseInt(document.getElementById('sendAmount').value);

    try {
        const response = await fetch('/api/send-coins', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ recipientPhone, amount }),
        });

        const data = await response.json();
        if (response.ok) {
            alert(data.message);
            loadWalletInfo();
        } else {
            alert(data.error);
        }
    } catch (error) {
        console.error('Error sending coins:', error);
        alert('An error occurred while sending coins');
    }
}

async function depositCoins() {
    const depositInput = document.getElementById('depositAmount');
    const amount = parseInt(depositInput.value);

    // Validate the input amount
    if (isNaN(amount) || amount <= 0) {
        alert('Please enter a valid positive number for the amount.');
        depositInput.value = ''; // Clear the input field
        return; // Stop further execution
    }

    try {
        const response = await fetch('/api/deposit-coins', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ amount }), // Send amount as part of the request body
        });

        const data = await response.json();
        if (response.ok) {
            alert(data.message);
            loadWalletInfo(); // Update the wallet information
            depositInput.value = ''; // Clear the input field after successful deposit
        } else {
            alert(data.error);
        }
    } catch (error) {
        console.error('Error depositing coins:', error);
        alert('An error occurred while depositing coins');
    }
}


function toggleTheme() {
    document.body.classList.toggle('dark-theme');
}

function logout() {
    window.location.href = '/logout';
}