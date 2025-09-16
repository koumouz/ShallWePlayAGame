const inputElement = document.getElementById("input");
const outputElement = document.getElementById("output");
const gameTitleTextElement = document.getElementById("game-title-text");
const turnCountTextElement = document.getElementById("turn-count-text");
const typedTextElement = document.getElementById("typed-text");
const introText = "Shall we play a game?";
const inputLineElement = document.getElementById("input-line");
const promptIndicator = document.getElementById("prompt-indicator");

if (inputElement) {
	const scheduleFocus = () => setTimeout(ensureInputFocus, 0);
	window.addEventListener("focus", ensureInputFocus);
	document.addEventListener("mousedown", scheduleFocus);
	document.addEventListener("touchstart", scheduleFocus, { passive: true });
}

let gameKey = null;
let turnCount = 0;
let gameInSession = false;
let availableGames = [];
let imageLoaderState = null;

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
	if (inputLineElement) {
		inputLineElement.classList.remove("hidden");
	}
	showPrompt();
	ensureInputFocus();

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
		inputElement.value = "";
	} else {
		inputElement.value = "Thinking...";
	}

	if (command.length > 100) {
		enableUserInput();
		return;
	}

	const commandToDisplay = command.includes("Start Game:") ? "" : command;
	const responseElement = appendCommandAndResponse(commandToDisplay);

	try {
		const result = await streamNextTurn(command, responseElement);
		const responseData = result || {};

		if (responseData.text) {
			responseElement.innerHTML = renderMarkdown(responseData.text.trim());
			scrollToBottom();
		}

		if (responseData.gameKey) {
			gameKey = responseData.gameKey;
		}

		if (typeof responseData.turnCount === "number") {
			turnCount = responseData.turnCount;
			turnCountTextElement.textContent = "Turn: " + turnCount;
		}

		if (responseData.imagePrompt) {
			displayImageLoader();
			generateImage(responseData.imagePrompt);
		}

		const isGameOver =
			responseData.gameOver === "true" ||
			(responseData.text && responseData.text.includes("GAME OVER"));

		if (isGameOver) {
			endGameSession();
			return;
		}

		enableUserInput();
	} catch (error) {
		console.error("Error generating next turn:", error);
		hideLoader();
		responseElement.textContent =
			"An error occurred while processing your request. Please try again.";
		enableUserInput();
	} finally {
		if (inputElement) {
			inputElement.value = "";
		}
		ensureInputFocus();
	}
}

async function streamNextTurn(command, responseElement) {
	const headers = {
		"Content-Type": "application/json",
	};

	let payload;

	if (command.includes("Start Game:")) {
		payload = {
			gameScenario: command.split(":")[1],
		};
	} else {
		payload = {
			gameKey: gameKey,
			prompt: command,
		};
	}

	const response = await fetch("/api/generateNextTurn", {
		method: "POST",
		headers: headers,
		body: JSON.stringify(payload),
	});

	if (!response.ok || !response.body) {
		throw new Error("Failed to communicate with the server");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let aggregatedRawText = "";
	let finalPayload = null;
	let doneReading = false;
	let loaderCleared = false;

	while (!doneReading) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}

		buffer += decoder.decode(value, { stream: true });
		const events = buffer.split("\n\n");
		buffer = events.pop() || "";

		for (const eventChunk of events) {
			const eventLines = eventChunk.split("\n").filter((line) => line.trim() !== "");

			for (const rawLine of eventLines) {
				if (!rawLine.startsWith("data:")) {
					continue;
				}

				const dataPayload = rawLine.slice(5).trim();

				if (!dataPayload) {
					continue;
				}

				if (dataPayload === "[DONE]") {
					doneReading = true;
					break;
				}

				let parsed;
				try {
					parsed = JSON.parse(dataPayload);
				} catch (error) {
					console.error("Failed to parse server stream payload:", dataPayload);
					continue;
				}

				switch (parsed.type) {
					case "delta": {
						const deltaText = parsed.text || "";
						aggregatedRawText += deltaText;
					const displayText = aggregatedRawText.split("IMAGE_PROMPT")[0];
					responseElement.innerHTML = renderMarkdown(displayText || "");
						if (!loaderCleared) {
							hideLoader();
							loaderCleared = true;
						}
						scrollToBottom();
						break;
					}
					case "complete": {
						finalPayload = parsed.data || {};
						if (finalPayload.text) {
							aggregatedRawText = finalPayload.text;
							responseElement.innerHTML = renderMarkdown(finalPayload.text);
							scrollToBottom();
						}
						if (!loaderCleared) {
							hideLoader();
							loaderCleared = true;
						}
						break;
					}
					case "error": {
						throw new Error(parsed.message || "Server error");
					}
					default:
						break;
				}
			}
		}
	}

	if (!loaderCleared) {
		hideLoader();
	}

	if (!finalPayload) {
		const [displayText, imagePromptText] = aggregatedRawText.split("IMAGE_PROMPT");
		finalPayload = { text: (displayText || "").trim() };
		if (imagePromptText) {
			finalPayload.imagePrompt = imagePromptText.replace(/^[:\s]+/, "").trim();
		}
	} else if (!finalPayload.text) {
		const [displayText, imagePromptText] = aggregatedRawText.split("IMAGE_PROMPT");
		finalPayload.text = (displayText || "").trim();
		if (!finalPayload.imagePrompt && imagePromptText) {
			finalPayload.imagePrompt = imagePromptText.replace(/^[:\s]+/, "").trim();
		}
	}

	return finalPayload;
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
	hideImageLoader({ skipFade: true });
	imageElement.style.opacity = 0;

	const canvasElement = document.createElement("canvas");
	canvasElement.id = "loading-canvas";
	canvasElement.width = 256;
	canvasElement.height = 256;
	document.getElementById("image-container").appendChild(canvasElement);

	const ctx = canvasElement.getContext("2d");
	const lineWidth = 4;
	const linesPerColumn = canvasElement.height / lineWidth;
	const fpsInterval = 1000 / 5;

	const state = {
		canvasElement,
		ctx,
		lineWidth,
		linesPerColumn,
		fpsInterval,
		lastDrawTime: 0,
		currentLine: 0,
		cancelled: false,
		rafId: null,
		fadeInterval: null,
	};

	imageLoaderState = state;

	function drawLine(timestamp) {
		if (state.cancelled) {
			return;
		}

		if (!state.lastDrawTime) {
			state.lastDrawTime = timestamp;
	}

		if (timestamp - state.lastDrawTime >= state.fpsInterval) {
			const y = state.currentLine * state.lineWidth;
			state.ctx.fillStyle = "#ffa500";
			state.ctx.fillRect(0, y, state.canvasElement.width, state.lineWidth);
			state.currentLine++;
			state.lastDrawTime = timestamp;
		}

		if (state.currentLine < state.linesPerColumn) {
			state.rafId = requestAnimationFrame(drawLine);
		}
	}

	state.rafId = requestAnimationFrame(drawLine);
}

function hideImageLoader(options = {}) {
	const imageElement = document.getElementById("game-image");
	const canvasElement = document.getElementById("loading-canvas");
	const skipFade = Boolean(options.skipFade);

	if (imageLoaderState) {
		imageLoaderState.cancelled = true;
		if (imageLoaderState.rafId) {
			cancelAnimationFrame(imageLoaderState.rafId);
		}
		if (imageLoaderState.fadeInterval) {
			clearInterval(imageLoaderState.fadeInterval);
		}
	}

	if (!canvasElement) {
		imageElement.style.opacity = 1;
		imageLoaderState = null;
		return;
	}

	if (skipFade) {
		canvasElement.remove();
		imageElement.style.opacity = 1;
		imageLoaderState = null;
		return;
	}

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
			imageLoaderState = null;
		}
	}, interval);

	if (imageLoaderState) {
		imageLoaderState.fadeInterval = fadeEffect;
	}
}

function endGameSession() {
	gameInSession = false;
	if (inputElement) {
		inputElement.value = "";
		inputElement.disabled = true;
		inputElement.blur();
	}
	if (inputLineElement) {
		inputLineElement.classList.add("hidden");
	}
	hidePrompt();
	hideLoader();
	turnCountTextElement.textContent = "Turn: " + turnCount;
}

function updateOutputText(command, outputText) {
	const responseElement = appendCommandAndResponse(command);
	typeText(responseElement, outputText.trim(), 0, 10, enableUserInput);
}

function appendCommandAndResponse(command) {
	if (inputElement) {
		inputElement.value = "";
	}
	ensureInputFocus();

	if (command) {
		const commandElement = document.createElement("div");
		commandElement.className = "input-line";
		commandElement.innerHTML = `<div class="prompt">> </div><div>${escapeHtml(
			command.trim()
		)}</div>`;
		outputElement.appendChild(commandElement);
	}

	const responseElement = document.createElement("div");
	responseElement.className = "response-text";
	outputElement.appendChild(responseElement);
	outputElement.appendChild(document.createElement("br"));
	scrollToBottom();

	return responseElement;
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
		element.textContent += text[index];
		setTimeout(() => typeText(element, text, index + 1, interval, callback), interval);
	} else {
		element.innerHTML = renderMarkdown(text);
		if (callback) {
			callback();
		}
	}

	if (outputElement) scrollToBottom();
}

function ensureInputFocus() {
	if (!inputElement) {
		return;
	}

	if (!document.hasFocus()) {
		return;
	}

	if (inputLineElement && inputLineElement.classList.contains("hidden")) {
		return;
	}

	if (!inputElement.disabled) {
		inputElement.focus();
	}
}

function showPrompt() {
	if (promptIndicator) {
		promptIndicator.classList.remove("hidden");
	}
}

function hidePrompt() {
	if (promptIndicator) {
		promptIndicator.classList.add("hidden");
	}
}

function escapeHtml(str) {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function renderMarkdown(text) {
	const escaped = escapeHtml(text);
	return escaped
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/__(.+?)__/g, "<strong>$1</strong>")
		.replace(/\*(.+?)\*/g, "<em>$1</em>")
		.replace(/_(.+?)_/g, "<em>$1</em>")
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\n/g, "<br>");
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
	if (!inputElement) {
		return;
	}

	inputElement.disabled = false;
	showPrompt();
	if (inputLineElement) {
		inputLineElement.classList.remove("input-disabled");
	}
	ensureInputFocus();
}

function disableUserInput() {
	if (!inputElement) {
		return;
	}

	inputElement.disabled = true;
	inputElement.blur();
	hidePrompt();
	if (inputLineElement) {
		inputLineElement.classList.add("input-disabled");
	}
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
