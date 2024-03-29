const inputElement = document.getElementById("input");
const outputElement = document.getElementById("output");
const gameTitleTextElement = document.getElementById("game-title-text");
const turnCountTextElement = document.getElementById("turn-count-text");
const typedTextElement = document.getElementById("typed-text");
const introText = "Shall we play a game?";

let gameKey = null;
let turnCount = 0;
let gameInSession = false;
let availableGames = [];

document.addEventListener("DOMContentLoaded", async () => {
	const isMobile = /Mobile/.test(navigator.userAgent);
	if (isMobile) {
		if (window.location.pathname !== "/index.html") {
			window.location.replace("/index.html");
		} else {
			document.getElementById("footer-text").className = "hidden";
			document.getElementById("terminal").style.width = "80%";

			let desktopBrowserText = "I'm sorry, mobile browsers are not supported.";
			typeText(document.getElementById("intro-text"), desktopBrowserText, 0, 50);
		}
		return;
	} // Check to see if this is a mobile browser and if so, ask the user to use a desktop browser

	if (document.getElementById("game-container")) {
		showGameSelector();
	} else if (document.getElementById("intro-text")) {
		// Display out quick intro and splash screen
		typeText(document.getElementById("intro-text"), introText, 0, 50, showEnterButton);
	}
});

async function showGameSelector() {
	const response = await makeRequest("/api/getAvailableGames");
	availableGames = response.games;
	let gameSelectString = "Greetings [USER]! Shall we play a game?\n\nAvailable games: \n";

	for (let i = 0; i < availableGames.length; i++) {
		if (availableGames[i].includes(".txt")) {
			gameSelectString += i + 1 + ": " + formatTitle(availableGames[i]) + "\n";
		}
	}

	gameSelectString += availableGames.length + 1 + ": Global Thermonuclear War\n";

	gameSelectString += "\n\nSelect [1 - " + (availableGames.length + 1) + "]:";
	updateOutputText(null, gameSelectString);

	// Make the input-line visible
	const inputLineElement = document.getElementById("input-line");
	inputLineElement.classList.remove("hidden");
	inputElement.focus();

	// Get ready for player input
	inputElement.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			if (inputElement.value.length >= 1) {
				event.preventDefault();
				processCommand(inputElement.value);
			}
		}
	});
}

function selectGame(gameScenarioIndex) {
	gameTitleTextElement.textContent = formatTitle(availableGames[gameScenarioIndex - 1]);
	startGame(availableGames[gameScenarioIndex - 1]);
}

async function startGame(gameScenario) {
	showLoader();

	// Clear the output text
	outputElement.innerHTML = "";

	// Start the game and get the initial scenario.
	gameInSession = true;
	turnCount = 0;
	await processCommand("Start Game:" + gameScenario);

	hideLoader();
}

async function processCommand(command) {
	if (!gameInSession) {
		// Yes, this is a little ugly. Hack the processCommand to treat game selection as a special case. I'll clean this up later.
		const number = parseInt(command, 10);
		if (Number.isInteger(number) && number >= 1 && number <= availableGames.length) {
			selectGame(number);
		} else if (number == availableGames.length + 1) {
			updateOutputText(
				"",
				"I'm sorry Professor, that game is no longer available. How about a different game?\n\nPlease enter a value [1 - " +
					(availableGames.length + 1) +
					"]"
			);
		} else {
			updateOutputText("", "Please enter a value [1 - " + (availableGames.length + 1) + "]");
		}
		return;
	}

	disableUserInput();
	if (command.includes("Start Game:")) {
		// Clean up this special case later...
		inputElement.value = ""; // This is here because we already have
	} else {
		// a loader when starting a new game
		inputElement.value = "Thinking...";
	}

	if (command.length > 100) {
		return;
	}

	let response = await generateNextTurn(command);

	if (command.includes("Start Game:")) {
		// Clean up this special case later...
		command = ""; // Shorten the command for display
	}

	// If the model determined Game Over, then... end the game (because this is a hack and you should fix it)
	if (response.text.includes("GAME OVER")) {
		gameOver(command, response.text);
		return;
	}

	// If the game is over, then... end the game
	if (response.gameOver == "true") {
		gameOver(command, response.text);
		return;
	}

	// Create a request to generate an image based on the descriptive prompt
	if (response.imagePrompt) {
		displayImageLoader();
		generateImage(response.imagePrompt);
	}

	// Clear out the past command
	inputElement.value = "";
	inputElement.focus();

	//Update the output text
	updateOutputText(command, response.text);

	// Update the turn counter
	turnCount = response.turnCount;
	turnCountTextElement.textContent = "Turn: " + turnCount;
}

async function generateNextTurn(command) {
	let response = null;

	if (command.includes("Start Game:")) {
		let body = JSON.stringify({
			gameScenario: command.split(":")[1],
		});

		response = await makeRequest("/api/startGame", body);
		gameKey = response.gameKey;
	} else {
		let body = JSON.stringify({
			gameKey: gameKey,
			prompt: command,
		});
		response = await makeRequest("/api/generateNextTurn", body);
	}

	return response;
}

async function generateImage(prompt) {
	let body = JSON.stringify({ prompt: prompt });

	// Make the request but don't parse the response as JSON
	let response = await fetch("/api/generateImage", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body,
	});

	if (response.ok) {
		// Read the response as an ArrayBuffer
		const imageBuffer = await response.arrayBuffer();

		// Update the image
		const imageBufferArray = new Uint8Array(imageBuffer);
		const blob = new Blob([imageBufferArray], { type: "image/png" });
		const imageElement = document.getElementById("game-image");
		const canvas = document.createElement("canvas");
		const ctx = canvas.getContext("2d");

		canvas.width = 256;
		canvas.height = 256;

		const tempImage = new Image();
		tempImage.src = URL.createObjectURL(blob);
		tempImage.onload = function () {
			ctx.drawImage(tempImage, 0, 0, 256, 256);

			// Set the globalCompositeOperation and fill with the tint color
			ctx.globalCompositeOperation = "multiply";
			ctx.fillStyle = "rgba(255, 165, 0, 0.8)";
			ctx.fillRect(0, 0, canvas.width, canvas.height);

			imageElement.src = canvas.toDataURL();

			// Set the alt text if available
			if (response.headers.get("X-Image-Alt-Text")) {
				imageElement.alt = response.headers.get("X-Image-Alt-Text");
			}

			hideImageLoader();
		};
	} else {
		console.error("Error generating image:", response.statusText);
	}
}

function displayImageLoader() {
	const imageElement = document.getElementById("game-image");
	imageElement.style.opacity = 0;

	const canvasElement = document.createElement("canvas");
	canvasElement.id = "loading-canvas";
	canvasElement.width = 256;
	canvasElement.height = 256;
	document.getElementById("image-container").appendChild(canvasElement);

	const ctx = canvasElement.getContext("2d");

	const lineWidth = 4;
	const linesPerColumn = canvasElement.height / lineWidth;
	const fps = 5;
	const fpsInterval = 1000 / fps;
	let lastDrawTime = 0;
	let currentLine = 0;

	function drawLine(timestamp) {
		if (!lastDrawTime) {
			lastDrawTime = timestamp;
		}

		if (timestamp - lastDrawTime >= fpsInterval) {
			const y = currentLine * lineWidth;

			ctx.fillStyle = "#ffa500";
			ctx.fillRect(0, y, canvasElement.width, lineWidth);

			currentLine++;
			lastDrawTime = timestamp;
		}

		if (currentLine < linesPerColumn) {
			requestAnimationFrame(drawLine);
		}
	}

	requestAnimationFrame(drawLine);
}

function hideImageLoader() {
	const imageElement = document.getElementById("game-image");
	const canvasElement = document.getElementById("loading-canvas");

	imageElement.style.opacity = 0;

	let opacity = 0;
	const interval = 200;
	const step = 0.15;

	const fadeEffect = setInterval(function () {
		if (opacity < 1) {
			opacity += step;
			imageElement.style.opacity = opacity;
			canvasElement.style.opacity = 1 - opacity;
		} else {
			clearInterval(fadeEffect);
			canvasElement.remove();
		}
	}, interval);
}

function gameOver(command, gameOverString) {
	gameInSession = false;

	document.getElementById("loader").className = "hidden";
	updateOutputText(command, gameOverString);
	inputElement.textContent = "";
	inputElement.removeEventListener("keydown", (event) => {});
	inputElement.parentElement.remove();
}

function updateOutputText(command, outputText) {
	// Clear out the past command
	inputElement.value = "";
	inputElement.focus();

	// Add command and response elements
	if (command) {
		const commandElement = document.createElement("div");
		commandElement.className = "input-line";
		commandElement.innerHTML = `<div class="prompt">> </div><div>${command.trim()}</div>`;
		outputElement.appendChild(commandElement);
	}

	const responseElement = document.createElement("div");
	outputElement.appendChild(responseElement);
	outputElement.appendChild(document.createElement("br"));

	// Type the response text with animation
	typeText(responseElement, outputText.trim(), 0, 10, enableUserInput);
}

async function makeRequest(url, body = null) {
	const headers = {
		"Content-Type": "application/json",
	};

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: headers,
			body: body,
		});

		const data = await response.json();
		return data.response;
	} catch (error) {
		console.error("Error communicating with the server:", error);
		return "An error occurred while processing your request.";
	}
}

function scrollToBottom() {
	outputElement.scrollTo(0, outputElement.scrollHeight);
}

function typeText(element, text, index = 0, interval = 5, callback) {
	if (index < text.length) {
		element.innerHTML += text[index];
		setTimeout(() => typeText(element, text, index + 1, interval, callback), interval);
	} else if (callback) {
		callback();
	}

	if (outputElement) scrollToBottom();
}

function formatTitle(string) {
	let gameTitle = string.split(".")[0];
	let words = gameTitle.split("_");
	for (word in words) {
		words[word] = words[word].charAt(0).toUpperCase() + words[word].slice(1);
	}
	gameTitle = words.join(" ");
	return gameTitle;
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

function showLoader() {
	document.getElementById("loader").textContent = "Loading, please wait...";
	document.getElementById("loader").className = "";
}

function hideLoader() {
	document.getElementById("loader").textContent = "";
	document.getElementById("loader").className = "hidden";
}

function showEnterButton() {
	const enterButton = document.getElementById("enter-button");
	enterButton.classList.remove("hidden");
	enterButton.classList.add("visible");
	enterButton.addEventListener("click", handleEnterButtonClick);
}

async function handleEnterButtonClick() {
	// Redirect the user to the game.html page
	window.location.href = "game.html";
}
