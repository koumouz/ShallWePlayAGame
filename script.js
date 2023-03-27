const inputElement = document.getElementById('input');
const outputElement = document.getElementById('output');
const turnHistory = [];

document.addEventListener('DOMContentLoaded', async () => {
    const response = await initGame();

    outputElement.innerHTML = `
        <div>${response}</div>
    `;
    scrollToBottom();
});

inputElement.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        processCommand(inputElement.value);
        inputElement.value = 'Loading, Please Wait...';
    }
});

async function initGame() {
    let result = await makeRequest('/api/initGame');
    turnHistory.push({"role": "assistant", "content": result});

    return result;
}

async function getNextTurn(prompt) {
    turnHistory.push({"role": "user", "content": prompt});

    let body = JSON.stringify({
        turnHistory: turnHistory,
    });

    let result = await makeRequest('/api/getNextTurn', body);
    turnHistory.push({"role": "assistant", "content": result});

    return result;
}

async function makeRequest(url, body) {
    const headers = {
        'Content-Type': 'application/json',
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: body,
        });

        const data = await response.json();
        return data.response;
    } catch (error) {
        console.error('Error communicating with the server:', error);
        return 'An error occurred while processing your request.';
    }
}

async function processCommand(command) {
    let result = await getNextTurn(command);

    inputElement.value = '';
    outputElement.innerHTML += `
        <div class="input-line">
            <div class="prompt">>></div>
            <div>${command}</div>
        </div>
        <div>${result}</div>
    `;
    scrollToBottom();
}


function scrollToBottom() {
    window.scrollTo(0, document.body.scrollHeight);
}
