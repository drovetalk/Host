
document.getElementById('generateInviteBtn').addEventListener('click', generateInvite);

async function generateInvite() {
    try {
        const response = await fetch('/generate-invite', { method: 'POST' });
        const data = await response.json();
        document.getElementById('inviteLink').textContent = data.inviteLink;
    } catch (error) {
        console.error('Error generating invite:', error);
    }
}

async function fetchInviteHistory() {
    try {
        const response = await fetch('/invite-history');
        const invites = await response.json();
        const inviteHistoryElement = document.getElementById('inviteHistory');
        inviteHistoryElement.innerHTML = '';
        invites.forEach(invite => {
            const li = document.createElement('li');
            li.textContent = `Code: ${invite.invite_code}, Used: ${invite.used}, Created: ${new Date(invite.created_at).toLocaleString()}, Invited User: ${invite.invited_user || 'Not used yet'}`;
            inviteHistoryElement.appendChild(li);
        });
    } catch (error) {
        console.error('Error fetching invite history:', error);
    }
}
