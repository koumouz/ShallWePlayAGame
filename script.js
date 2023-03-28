const inputElement = document.getElementById('input');
const outputElement = document.getElementById('output');
const typedTextElement = document.getElementById('typed-text');
const turnHistory = [];
const introText = 'Would you like to play a game?';

document.addEventListener('DOMContentLoaded', async () => {
    if (document.getElementById('typed-text')) {
        // Display out quick intro
        typeText(document.getElementById('typed-text'), introText, 0, 100, showOptions);
    } else {
        // Start the game
        initGame();
    }
});

async function initGame() {
    // Get the inital game setting
    let response = await makeRequest('/api/initGame');
    turnHistory.push({"role": "assistant", "content": response.text});

    outputElement.textContent = "";
    const responseElement = document.createElement('div');
    responseElement.textContent = response.text.trim();
    responseElement.style.marginBottom = '1em'; // Add margin to the bottom
    outputElement.appendChild(responseElement);
    scrollToBottom();

    // Make the input-line visible
    const inputLineElement = document.getElementById('input-line');
    inputLineElement.classList.remove('hidden');
    inputLineElement.style.display = 'flex';
    inputElement.focus();

    // Get ready for player input
    inputElement.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            processCommand(inputElement.value);
            inputElement.value = 'Thinking, please wait...';
        }
    });
}

async function generateNextTurn(prompt) {
    turnHistory.push({"role": "user", "content": prompt});

    let body = JSON.stringify({
        turnHistory: turnHistory,
    });

    let result = await makeRequest('/api/generateNextTurn', body);
    turnHistory.push({"role": "assistant", "content": result.text});

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
    let response = await generateNextTurn(command);

    if(response.image !== undefined) {
        // Update the image
        const imageBuffer = new Uint8Array(response.image.data);
        const blob = new Blob([imageBuffer], { type: 'image/png' });
        const imageElement = document.getElementById('game-image');
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        canvas.width = 256;
        canvas.height = 256;

        const tempImage = new Image();
        tempImage.src = URL.createObjectURL(blob);
        tempImage.onload = function () {
            ctx.drawImage(tempImage, 0, 0, 256, 256);
            imageElement.src = canvas.toDataURL();
        };
    }

    // Update the text
    inputElement.value = '';
    inputElement.focus();

    // Add command and response elements
    const commandElement = document.createElement('div');
    commandElement.className = 'input-line';
    commandElement.innerHTML = `<div class="prompt">>></div><div>${command.trim()}</div>`;
    outputElement.appendChild(commandElement);

    const responseElement = document.createElement('div');
    outputElement.appendChild(responseElement);

    // Type the response text with animation
    typeText(responseElement, response.text.trim());

    scrollToBottom();
}

function showOptions() {
    const yesButton = document.createElement('button');
    yesButton.textContent = 'Yes';
    yesButton.onclick = handleYesButtonClick;

    const noButton = document.createElement('button');
    noButton.textContent = 'No';
    noButton.onclick = handleNoButtonClick;

    typedTextElement.appendChild(document.createElement('br'));
    typedTextElement.appendChild(yesButton);
    typedTextElement.appendChild(noButton);
}

function handleYesButtonClick() {
   window.location.href = 'game.html';
}

function handleNoButtonClick() {
    window.location.href = 'https://www.google.com';
}

function scrollToBottom() {
    const terminal = document.getElementById('terminal');
    terminal.scrollTo(0, terminal.scrollHeight);
}

function typeText(element, text, index = 0, interval = 10, callback) {
    if (index < text.length) {
        element.innerHTML += text[index];
        setTimeout(() => typeText(element, text, index + 1, interval, callback), interval);
    }
    else {
        callback();
    }
}
