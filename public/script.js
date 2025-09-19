const inputElement = document.getElementById("input");
const outputElement = document.getElementById("output");
const gameTitleTextElement = document.getElementById("game-title-text");
const turnCountTextElement = document.getElementById("turn-count-text");
const typedTextElement = document.getElementById("typed-text");
const introText = "Shall we play a game?";
const NO_IMAGE_CHANGE_SENTINEL = "NO IMAGE CHANGE";
const inputLineElement = document.getElementById("input-line");
const promptIndicator = document.getElementById("prompt-indicator");
const imageToggleButton = document.getElementById("image-toggle-button");
const footerBarElement = document.getElementById("footer-bar");

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
let imageGenerationEnabled = true;
let lastImagePrompt = null;
let currentNarrativeMode = "auto";

const IMAGE_ENABLE_COMMANDS = new Set([
	"enable images",
	"images on",
	"turn on images",
	"enable image generation",
	"show images",
]);

const IMAGE_DISABLE_COMMANDS = new Set([
	"disable images",
	"images off",
	"turn off images",
	"disable image generation",
	"hide images",
]);

const NARRATIVE_MODE_COMMANDS = new Map([
	["verbose", "verbose"],
	["brief", "brief"],
	["superbrief", "superbrief"],
	["super brief", "superbrief"],
	["normal", "auto"],
	["standard", "auto"],
	["reset narration", "auto"],
]);

const HELP_COMMANDS = new Set(["help", "?", "commands"]);

const HELP_TEXT = [
	"**System commands**",
	"`enable images` / `images on` - resume generating scene art and show the image panel.",
	"`disable images` / `images off` - stop creating scene art and hide the image panel.",
	"`verbose` - always deliver full room descriptions with rich detail.",
	"`brief` - keep responses short and focus on what is new this turn.",
	"`superbrief` - respond with the quickest possible summary.",
	"`normal` - return to the default narration style.",
	"`help` - show this list again.",
	"",
	"You can also toggle images with the button at the bottom of the screen.",
].join("\n");

const NARRATIVE_MODE_LABELS = {
	auto: "normal",
	verbose: "verbose",
	brief: "brief",
	superbrief: "super brief",
};

const NARRATIVE_MODE_FEEDBACK = {
	auto: "Narration reset to the default style.",
	verbose: "Narration set to verbose mode. Expect full room descriptions each turn.",
	brief: "Narration set to brief mode. I will focus on new details in a couple sentences.",
	superbrief: "Narration set to super brief mode. I will reply with the fastest possible summary.",
};


document.addEventListener("DOMContentLoaded", async () => {
	if (document.getElementById("game-container")) {
		hideImageContainer();
		hideFooterBar();
		updateImageToggleUI();
		if (imageToggleButton) {
			imageToggleButton.addEventListener("click", handleImageToggleButtonClick);
		}
		showGameSelector();
	} else if (document.getElementById("intro-text")) {
		// Display out quick intro and splash screen
		typeText(document.getElementById("intro-text"), introText, 0, 50, showEnterButton);
	}
});

/**
 * Fetches the list of available scenarios and renders the initial game
 * selection menu, wiring up the input prompt for player commands.
 */
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

/**
 * Updates the UI with the chosen scenario and kicks off the initial turn.
 */
function selectGame(gameScenarioIndex) {
	gameTitleTextElement.textContent = formatTitle(availableGames[gameScenarioIndex - 1]);
	startGame(availableGames[gameScenarioIndex - 1]);
}

/**
 * Resets session state and requests the opening turn for the selected game.
 */
async function startGame(gameScenario) {
	showLoader();

	// Clear the output text
	outputElement.innerHTML = "";

	// Start the game and get the initial scenario.
	gameInSession = true;
	lastImagePrompt = null;
	turnCount = 0;
	if (imageGenerationEnabled) {
		showImageContainer();
	} else {
		hideImageContainer();
	}
	showFooterBar();
	turnCountTextElement.textContent = "Turn: " + turnCount;
	await processCommand("Start Game:" + gameScenario);

	hideLoader();
}

/**
 * Trims and lowercases player input so command matching can ignore spacing.
 */
function normalizePlayerCommand(command) {
	if (typeof command !== "string") {
		return "";
	}

	return command.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Echoes a system command back to the output log alongside markdown feedback.
 */
function respondToPlayerCommand(commandText, responseMarkdown) {
	const responseElement = appendCommandAndResponse(commandText);
	responseElement.innerHTML = renderMarkdown(responseMarkdown);
	scrollToBottom();
}

/**
 * Reveals the footer control bar if it exists in the DOM.
 */
function showFooterBar() {
	if (!footerBarElement) {
		return;
	}

	footerBarElement.classList.remove("hidden");
}

/**
 * Hides the footer control bar and leaves it untouched when already hidden.
 */
function hideFooterBar() {
	if (!footerBarElement) {
		return;
	}

	if (!footerBarElement.classList.contains("hidden")) {
		footerBarElement.classList.add("hidden");
	}
}

/**
 * Syncs the image toggle button label and state with the current preference.
 */
function updateImageToggleUI() {
	if (!imageToggleButton) {
		return;
	}

	const label = imageGenerationEnabled ? "Images: On" : "Images: Off";
	imageToggleButton.textContent = label;
	imageToggleButton.setAttribute("aria-pressed", imageGenerationEnabled ? "true" : "false");
	imageToggleButton.classList.toggle("toggle-off", !imageGenerationEnabled);
}

/**
 * Handles button clicks by toggling image generation and restoring focus.
 */
function handleImageToggleButtonClick() {
	setImageGenerationEnabled(!imageGenerationEnabled);
	ensureInputFocus();
}

/**
 * Updates the image generation flag and performs any follow-up UI work.
 */
function setImageGenerationEnabled(enabled) {
	const shouldEnable = Boolean(enabled);
	if (shouldEnable === imageGenerationEnabled) {
		return { changed: false, status: shouldEnable ? "alreadyEnabled" : "alreadyDisabled" };
	}

	imageGenerationEnabled = shouldEnable;
	updateImageToggleUI();

	if (!shouldEnable) {
		hideImageContainer();
		return { changed: true, status: "disabled" };
	}

	if (!lastImagePrompt) {
		updateImageStatus("");
		return { changed: true, status: "enabledNoPrompt" };
	}

	regenerateImageAfterToggle().catch((error) => {
		console.error("Error regenerating image after enabling:", error);
		updateImageStatus("Image generation failed. Please try again.");
	});
	return { changed: true, status: "enabledWithImage" };
}

/**
 * Regenerates the last prompt when images are re-enabled so the panel updates.
 */
async function regenerateImageAfterToggle() {
	if (!lastImagePrompt) {
		return;
	}

	const inputWasDisabled = inputElement ? inputElement.disabled : false;
	if (!inputWasDisabled) {
		disableUserInput();
	}

	try {
		await generateImage(lastImagePrompt);
	} finally {
		if (!inputWasDisabled) {
			enableUserInput();
		}
	}
}

/**
 * Coerces narrative mode input into the supported option identifiers.
 */
function normalizeNarrativeModeValue(value) {
	if (typeof value !== "string") {
		return "auto";
	}

	const normalized = value.trim().toLowerCase();
	if (normalized === "super brief") {
		return "superbrief";
	}

	if (normalized === "verbose" || normalized === "brief" || normalized === "superbrief" || normalized === "auto") {
		return normalized;
	}

	return "auto";
}

/**
 * Records the selected narrative mode and returns whether it changed.
 */
function setNarrativeMode(mode) {
	const normalized = normalizeNarrativeModeValue(mode);
	if (normalized === currentNarrativeMode) {
		return { changed: false, mode: currentNarrativeMode };
	}

	currentNarrativeMode = normalized;
	return { changed: true, mode: currentNarrativeMode };
}

/**
 * Interprets system-level commands (help, toggles, narration) before gameplay
 * so they do not trigger API calls.
 */
function handlePlayerCommand(rawCommand) {
	const normalizedCommand = normalizePlayerCommand(rawCommand);
	if (!normalizedCommand) {
		return false;
	}

	if (HELP_COMMANDS.has(normalizedCommand)) {
		respondToPlayerCommand(rawCommand, HELP_TEXT);
		return true;
	}

	if (IMAGE_ENABLE_COMMANDS.has(normalizedCommand)) {
		const result = setImageGenerationEnabled(true);
		let message;
		switch (result.status) {
			case "alreadyEnabled": {
				message = "Image generation is already enabled.";
				break;
			}
			case "enabledWithImage": {
				message = "Image generation enabled. Rendering the most recent scene now.";
				break;
			}
			case "enabledNoPrompt": {
				message = "Image generation enabled. I will draw the next scene as soon as a prompt arrives.";
				break;
			}
			default: {
				message = "Image generation enabled.";
			}
		}
		respondToPlayerCommand(rawCommand, message);
		return true;
	}

	if (IMAGE_DISABLE_COMMANDS.has(normalizedCommand)) {
		const result = setImageGenerationEnabled(false);
		let message;
		switch (result.status) {
			case "alreadyDisabled": {
				message = "Image generation is already disabled.";
				break;
			}
			case "disabled": {
				message = "Image generation disabled. The image panel is hidden, but the latest prompt is saved.";
				break;
			}
			default: {
				message = "Image generation disabled.";
			}
		}
		respondToPlayerCommand(rawCommand, message);
		return true;
	}

	if (NARRATIVE_MODE_COMMANDS.has(normalizedCommand)) {
		const targetMode = NARRATIVE_MODE_COMMANDS.get(normalizedCommand);
		const result = setNarrativeMode(targetMode);
		const label = NARRATIVE_MODE_LABELS[result.mode] || result.mode;
		let message;
		if (result.changed) {
			message = NARRATIVE_MODE_FEEDBACK[result.mode] || `Narration set to ${label}.`;
		} else {
			message = `Narration is already set to ${label}.`;
		}
		respondToPlayerCommand(rawCommand, message);
		return true;
	}

	return false;
}

/**
 * Main entry point for player input: handles selection flow, system commands,
 * and streaming turns from the backend.
 */
async function processCommand(command) {
	abortActiveImageRequest();
	updateImageStatus("");

	const trimmedCommand = typeof command === "string" ? command.trim() : "";
	if (!trimmedCommand) {
		if (inputElement) {
			inputElement.value = "";
		}
		ensureInputFocus();
		return;
	}

	if (!gameInSession) {
		if (await handlePlayerCommand(trimmedCommand)) {
			if (inputElement) {
				inputElement.value = "";
			}
			ensureInputFocus();
			return;
		}

		// Yes, this is a little ugly. Hack the processCommand to treat game selection as a special case. I'll clean this up later.
		const number = parseInt(trimmedCommand, 10);
		if (Number.isInteger(number) && number >= 1 && number <= availableGames.length) {
			selectGame(number);
		} else if (number === availableGames.length + 1) {
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

	if (await handlePlayerCommand(trimmedCommand)) {
		if (inputElement) {
			inputElement.value = "";
		}
		ensureInputFocus();
		return;
	}

	disableUserInput();
	if (trimmedCommand.includes("Start Game:")) {
		inputElement.value = "";
	} else {
		inputElement.value = "Thinking...";
	}

	if (trimmedCommand.length > 100) {
		enableUserInput();
		return;
	}

	const commandToDisplay = trimmedCommand.includes("Start Game:") ? "" : trimmedCommand;
	const responseElement = appendCommandAndResponse(commandToDisplay);

	try {
		const result = await streamNextTurn(trimmedCommand, responseElement);
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
			lastImagePrompt = normalizedImagePrompt;
			if (imageGenerationEnabled) {
				await generateImage(normalizedImagePrompt);
			} else {
				hideImageContainer();
			}
		} else if (!imageGenerationEnabled) {
			hideImageContainer();
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

/**
 * Streams a turn response from the server, progressively rendering markdown
 * while collecting the final payload with metadata.
 */
async function streamNextTurn(command, responseElement) {
	const headers = {
		"Content-Type": "application/json",
	};

	let payload;

	if (command.includes("Start Game:")) {
		payload = {
			gameScenario: command.split(":")[1],
			narrativeMode: currentNarrativeMode,
		};
	} else {
		payload = {
			gameKey: gameKey,
			prompt: command,
			narrativeMode: currentNarrativeMode,
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

/**
 * Cleans image prompt text and filters out sentinel values indicating no
 * change.
 */
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

/**
 * Requests an image from the backend, streaming status updates to the UI and
 * allowing the request to be aborted.
 */
async function generateImage(prompt) {
	if (!imageGenerationEnabled) {
		return;
	}

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

/**
 * Processes individual SSE events from image generation, updating the screen
 * or deciding when the stream is complete.
 */
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

/**
 * Writes the generated image to the DOM using a base64 data URL and optional
 * alt text.
 */
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

/**
 * Displays human-readable status text beneath the image panel.
 */
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

/**
 * Makes the image container visible so newly generated art can be displayed.
 */
function showImageContainer() {
	const container = document.getElementById("image-container");
	if (!container) {
		return;
	}

	container.classList.remove("hidden");
}

/**
 * Hides the image container, clears status text, and cancels any in-flight
 * image request.
 */
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

/**
 * Aborts any in-progress image fetch so a new one can start cleanly.
 */
function abortActiveImageRequest() {
	if (activeImageAbortController) {
		activeImageAbortController.abort();
		activeImageAbortController = null;
	}
}

/**
 * Resets UI state when the adventure finishes or the session ends.
 */
function endGameSession() {
	gameInSession = false;
	lastImagePrompt = null;
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
	hideFooterBar();
}

/**
 * Writes a command/response pair to the output log using the typing effect.
 */
function updateOutputText(command, outputText) {
	const responseElement = appendCommandAndResponse(command);
	typeText(responseElement, outputText.trim(), 0, 10, enableUserInput);
}

/**
 * Appends a formatted command line and placeholder response element to the
 * transcript, returning the response container.
 */
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

/**
 * Issues a JSON POST request to the backend and returns the nested response
 * payload, logging any errors for diagnostics.
 */
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

/**
 * Keeps the output log scrolled to the latest entry.
 */
function scrollToBottom() {
	outputElement.scrollTo(0, outputElement.scrollHeight);
}

/**
 * Types out text character-by-character before rendering the final markdown.
 */
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

/**
 * Brings focus back to the command input when it is visible and enabled.
 */
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

/**
 * Displays the input prompt caret.
 */
function showPrompt() {
	if (promptIndicator) {
		promptIndicator.classList.remove("hidden");
	}
}

/**
 * Hides the input prompt caret.
 */
function hidePrompt() {
	if (promptIndicator) {
		promptIndicator.classList.add("hidden");
	}
}

/**
 * Escapes HTML-sensitive characters before injecting user text into the DOM.
 */
function escapeHtml(str) {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

/**
 * Applies a small subset of markdown formatting to plain text content.
 */
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

/**
 * Converts a snake_case scenario filename into a human-friendly title.
 */
function formatTitle(string) {
	let gameTitle = string.split(".")[0];
	let words = gameTitle.split("_");
	for (word in words) {
		words[word] = words[word].charAt(0).toUpperCase() + words[word].slice(1);
	}
	gameTitle = words.join(" ");
	return gameTitle;
}

/**
 * Re-enables the command input and restores prompt styling.
 */
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

/**
 * Temporarily disables player input and removes visual focus cues.
 */
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

/**
 * Reveals the loading indicator with a standard message.
 */
function showLoader() {
	document.getElementById("loader").textContent = "Loading, please wait...";
	document.getElementById("loader").className = "";
}

/**
 * Hides the loading indicator.
 */
function hideLoader() {
	document.getElementById("loader").textContent = "";
	document.getElementById("loader").className = "hidden";
}

/**
 * Displays the splash screen enter button and wires its click handler.
 */
function showEnterButton() {
	const enterButton = document.getElementById("enter-button");
	enterButton.classList.remove("hidden");
	enterButton.classList.add("visible");
	enterButton.addEventListener("click", handleEnterButtonClick);
}

/**
 * Navigates from the intro splash page to the main game interface.
 */
async function handleEnterButtonClick() {
	// Redirect the user to the game.html page
	window.location.href = "game.html";
}
