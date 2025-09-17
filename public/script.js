const inputElement = document.getElementById("input");
const outputElement = document.getElementById("output");
const gameTitleTextElement = document.getElementById("game-title-text");
const turnCountTextElement = document.getElementById("turn-count-text");
const typedTextElement = document.getElementById("typed-text");
const introText = "Shall we play a game?";
const NO_IMAGE_CHANGE_SENTINEL = "NO IMAGE CHANGE";
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
let activeImageAbortController = null;


document.addEventListener("DOMContentLoaded", async () => {
	if (document.getElementById("game-container")) {
		hideImageContainer();
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
	showImageContainer();
	turnCount = 0;
	await processCommand("Start Game:" + gameScenario);

	hideLoader();
}

async function processCommand(command) {
	abortActiveImageRequest();
	updateImageStatus("");

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

		const normalizedImagePrompt = normalizeImagePrompt(responseData.imagePrompt);
		if (normalizedImagePrompt) {
			await generateImage(normalizedImagePrompt);
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
		const normalizedImagePrompt = normalizeImagePrompt(imagePromptText);
		if (normalizedImagePrompt) {
			finalPayload.imagePrompt = normalizedImagePrompt;
		}
	} else if (!finalPayload.text) {
		const [displayText, imagePromptText] = aggregatedRawText.split("IMAGE_PROMPT");
		finalPayload.text = (displayText || "").trim();
		if (!finalPayload.imagePrompt) {
			const normalizedImagePrompt = normalizeImagePrompt(imagePromptText);
			if (normalizedImagePrompt) {
				finalPayload.imagePrompt = normalizedImagePrompt;
			}
		}
	}

	return finalPayload;
}

function normalizeImagePrompt(rawPrompt) {
	if (!rawPrompt) {
		return null;
	}

	const trimmedPrompt = String(rawPrompt).replace(/^[:\s]+/, "").trim();
	if (!trimmedPrompt) {
		return null;
	}

	const normalized = trimmedPrompt.replace(/[.!?\s]+$/u, "").toUpperCase();
	if (normalized.startsWith(NO_IMAGE_CHANGE_SENTINEL)) {
		return null;
	}

	return trimmedPrompt;
}

async function generateImage(prompt) {
	const normalizedPrompt = normalizeImagePrompt(prompt);
	if (!normalizedPrompt) {
		updateImageStatus("");
		return;
	}

	updateImageStatus("Preparing image...");
	showImageContainer();

	let finalEventHandled = false;
	abortActiveImageRequest();

	const controller = new AbortController();
	activeImageAbortController = controller;

	try {
		const response = await fetch("/api/generateImage", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: normalizedPrompt }),
			signal: controller.signal,
		});

		if (!response.ok || !response.body) {
			throw new Error("Failed to communicate with the server");
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let doneReading = false;

		while (!doneReading) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}

			if (!value) {
				continue;
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
						console.error("Failed to parse image stream payload:", dataPayload);
						continue;
					}

					const shouldStop = handleImageStreamEvent(parsed);
					if (shouldStop) {
						finalEventHandled = true;
						doneReading = true;
						break;
					}
				}

				if (doneReading) {
					break;
				}
			}
		}

		await reader.cancel().catch(() => {});

		if (!finalEventHandled) {
			updateImageStatus("");
		}
	} catch (error) {
		if (error?.name === "AbortError") {
			return;
		}
		console.error("Error generating image:", error);
		updateImageStatus("Image generation failed. Please try again.");
	} finally {
		if (activeImageAbortController === controller) {
			activeImageAbortController = null;
		}
	}
}

function handleImageStreamEvent(event) {
	if (!event || typeof event !== "object") {
		return false;
	}

	switch (event.type) {
		case "status": {
			updateImageStatus(event.message || "");
			break;
		}
		case "progress": {
			if (typeof event.progress === "number") {
				const constrained = Math.max(0, Math.min(100, Math.round(event.progress)));
				updateImageStatus(`Generating image... ${constrained}%`);
			} else if (event.message) {
				updateImageStatus(event.message);
			}
			break;
		}
		case "complete": {
			const payload = event.data || {};
			if (payload.image) {
				setImageFromBase64(payload.image, payload.altText || "");
				updateImageStatus("");
				return true;
			}
			break;
		}
		case "error": {
			updateImageStatus(event.message || "Image generation failed.");
			return true;
		}
		default:
			break;
	}

	return false;
}

function setImageFromBase64(imageBase64, altText) {
	const imageElement = document.getElementById("game-image");
	if (!imageElement || !imageBase64) {
		return;
	}

	const cleanedBase64 = imageBase64.replace(/\s+/g, "");
	imageElement.src = `data:image/png;base64,${cleanedBase64}`;
	if (typeof altText === "string" && altText.trim()) {
		imageElement.alt = altText.trim();
	}
}

function updateImageStatus(message) {
	const statusElement = document.getElementById("image-status");
	if (!statusElement) {
		return;
	}

	const trimmed = typeof message === "string" ? message.trim() : "";
	if (trimmed) {
		statusElement.textContent = trimmed;
		statusElement.classList.remove("hidden");
	} else {
		statusElement.textContent = "";
		statusElement.classList.add("hidden");
	}
}

function showImageContainer() {
	const container = document.getElementById("image-container");
	if (!container) {
		return;
	}

	container.classList.remove("hidden");
}

function hideImageContainer() {
	const container = document.getElementById("image-container");
	if (!container) {
		return;
	}

	if (!container.classList.contains("hidden")) {
		container.classList.add("hidden");
	}

	updateImageStatus("");
	abortActiveImageRequest();
	const imageElement = document.getElementById("game-image");
	if (imageElement) {
		imageElement.src = "images/smol.png";
		imageElement.alt = "";
	}
}

function abortActiveImageRequest() {
	if (activeImageAbortController) {
		activeImageAbortController.abort();
		activeImageAbortController = null;
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
	hideImageContainer();
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
