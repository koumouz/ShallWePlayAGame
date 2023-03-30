const inputElement = document.getElementById('input');
const outputElement = document.getElementById('output');
const gameTitleTextElement = document.getElementById('game-title-text');
const turnCountTextElement = document.getElementById('turn-count-text');
const typedTextElement = document.getElementById('typed-text');
const turnHistory = [];
const introText = 'Would you like to play a game?';
var turnCount = 0;
const maxTurns = 10; // TODO: move this server side
const gameOverString = "You have reached the end of this game session. For now, games are limited to " + maxTurns + " turns but we'll be expanding on this in the future. Thanks for playing!"

document.addEventListener('DOMContentLoaded', async () => {
    if (document.getElementById('intro-text')) {
        // Display out quick intro 
        typeText(document.getElementById('intro-text'), introText, 0, 50, showLoginForm);
    } else {
        // Start the game
        initGame();
    }
});

async function initGame() { 
    // Start the game and get the initial scenario.
    turnCount = 0;
    gameTitleTextElement.textContent = "The Island";    //hard coded for now, will fix when I added a game selector
    await processCommand("Start a New Game");

    // Make the input-line visible
    const inputLineElement = document.getElementById('input-line');
    inputLineElement.classList.remove('hidden');
    inputElement.focus();

    // Hide the initial loader
    document.getElementById('loader').className = "hidden";

    // Get ready for player input
    inputElement.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            if(inputElement.value.length > 3) {
                event.preventDefault();
                processCommand(inputElement.value);
                inputElement.value = 'Thinking...';
            }
        }
    });
}

async function generateNextTurn(prompt) {
    let response = null;

    if(prompt == "Start a New Game") {
        response = await makeRequest('/api/initGame');
    } else {
        turnHistory.push({"role": "user", "content": prompt});
        let body = JSON.stringify({ turnHistory: turnHistory });
        response = await makeRequest('/api/generateNextTurn', body);
    }

    turnHistory.push({"role": "assistant", "content": response.text});
    return response;
}

async function generateImage(prompt) {
    let body = JSON.stringify({ prompt: prompt });
    
    // Make the request but don't parse the response as JSON
    let response = await fetch('/api/generateImage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
    });

    if (response.ok) {
        // Read the response as an ArrayBuffer
        const imageBuffer = await response.arrayBuffer();

        // Update the image
        const imageBufferArray = new Uint8Array(imageBuffer);
        const blob = new Blob([imageBufferArray], { type: 'image/png' });
        const imageElement = document.getElementById('game-image');
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        canvas.width = 256;
        canvas.height = 256;

        const tempImage = new Image();
        tempImage.src = URL.createObjectURL(blob);
        tempImage.onload = function () {
            ctx.drawImage(tempImage, 0, 0, 256, 256);

            // Set the globalCompositeOperation and fill with the tint color
            ctx.globalCompositeOperation = 'multiply';
            ctx.fillStyle = 'rgba(255, 165, 0, 0.8)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            imageElement.src = canvas.toDataURL();

            // Set the alt text if available
            if (response.headers.get('X-Image-Alt-Text')) {
                imageElement.alt = response.headers.get('X-Image-Alt-Text');
            }
        };
    } else {
        console.error('Error generating image:', response.statusText);
    }
}

async function processCommand(command) {
    disableUserInput();

    // Create a (crude, will fix later) limit to cap the number of turns the player can make
    // TODO: move this server side
    if(turnCount >= maxTurns) {
        gameOver();
        return;
    }
    else if (command.length > 50) {
        return;
    }
       
    let response = await generateNextTurn(command);

    // Create a request to generate an image based on the descriptive prompt
    if(response.imagePrompt) {
        generateImage(response.imagePrompt);
    }

    // Clear out the past command
    inputElement.value = '';
    inputElement.focus();

    //Update the output text
    updateOutputText(command, response.text);

    // Update the turn counter
    turnCount++;
    turnCountTextElement.textContent = "Turn: " + turnCount;
}

function gameOver() {
    updateOutputText('', gameOverString);
    const inputLineElement = document.getElementById('input-line');
    inputElement.textContent = '';
    inputElement.removeEventListener('keydown', (event) => {
    });
    inputElement.parentElement.remove();
}

function updateOutputText(command, outputText) {
    // Clear out the past command
    inputElement.value = '';
    inputElement.focus();

    // Add command and response elements
    const commandElement = document.createElement('div');
    commandElement.className = 'input-line';
    commandElement.innerHTML = `<div class="prompt">> </div><div>${command.trim()}</div>`;
    outputElement.appendChild(commandElement);

    const responseElement = document.createElement('div');
    outputElement.appendChild(responseElement);
    outputElement.appendChild(document.createElement('br'));

    // Type the response text with animation
    typeText(responseElement, outputText.trim(), 0, 10, enableUserInput);
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

function scrollToBottom() {
    outputElement.scrollTo(0, outputElement.scrollHeight);
}

function typeText(element, text, index = 0, interval = 10, callback) {
    if (index < text.length) {
        element.innerHTML += text[index];
        setTimeout(() => typeText(element, text, index + 1, interval, callback), interval);
    }
    else if(callback) {
        callback();
    }

    if(outputElement)
        scrollToBottom(); 
}

function enableUserInput() {
    // Enable user input when we are ready to receive a command
    inputElement.disabled = false;
    inputElement.focus();
}

function disableUserInput() {
    // Disable user input while we process a command
    inputElement.disabled = true;
}

function showLoginForm() {
    const loginForm = document.getElementById('login-form');
    loginForm.classList.remove('hidden');
    loginForm.classList.add('visible');
    loginForm.addEventListener('submit', handleLoginFormSubmit);
}

async function handleLoginFormSubmit(event) {
    event.preventDefault();

    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    const response = await validateCredentials(username, password);

    if (response.success) {
        window.location.href = 'game.html';
    } else {
        document.getElementById('username').value = '';
        document.getElementById('password').value = '';
    }
}

async function validateCredentials(username, password) {
    const body = JSON.stringify({ username, password });

    try {
        const response = await fetch('/api/authenticate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body,
        });
        const data = await response.json();

        return data;
    } catch (error) {
        console.error('Error validating credentials:', error);
        return { success: false };
    }
}