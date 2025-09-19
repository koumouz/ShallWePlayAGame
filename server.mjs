import express from "express";
import { fileURLToPath } from "url";
import { dirname, join, relative, resolve, sep } from "path";
import fetch from "node-fetch";
import fs from "fs/promises";
import dotenv from "dotenv";
import crypto from "crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pkg from "pg";

const { Pool } = pkg;

if (process.env.NODE_ENV !== "production") {
	dotenv.config({ path: "./config.env" });
}

// Initialize things
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const config = buildConfig();
const app = express();
const pool = new Pool(config.database);
let dbInitializationPromise = null;

app.disable("x-powered-by");
if (config.env === "production") {
	app.set("trust proxy", 1);
}
app.use(
	helmet({
		contentSecurityPolicy: false,
		crossOriginEmbedderPolicy: false,
	})
);

const requestRateLimiter = rateLimit({
	windowMs: config.rateLimit.windowMs,
	max: config.rateLimit.max,
	standardHeaders: true,
	legacyHeaders: false,
});

app.use(
	"/api/",
	requestRateLimiter
);
app.use(
	"/api/",
	express.json({ limit: config.limits.requestBody })
);

/* OpenAI API Endpoints */
const TEXT_API_URI = "https://api.openai.com/v1/responses";
const IMAGE_API_URI = "https://api.openai.com/v1/images/generations";

/* Constants and Globals */
const {
	openAI: {
		apiKey: OPENAI_API_KEY,
		textModel,
		imageModel: IMAGE_MODEL,
		imageSize: IMAGE_SIZE,
		imageQuality: IMAGE_QUALITY,
	},
	game: { maxTurns, createImages, maxOutputTokens: numMaxTokens, temperature, defaultScenario: defaultGameScenario },
	prompts,
	limits,
} = config;

const {
	prompt: promptMaxLength,
	imagePrompt: imagePromptMaxLength,
	scenarioName: scenarioNameMaxLength,
} = limits;

// Game Rules
const promptPaths = {
	systemRules: prompts.systemRules,
	gamesDir: prompts.gamesDir,
	root: prompts.root,
};

const VALID_SCENARIO_FILE_REGEX = /^[a-z0-9_-]+\.txt$/i;

try {
	resolveScenarioFilename(defaultGameScenario);
} catch (error) {
	console.error("Invalid default scenario configuration:", error.message);
	process.exit(1);
}

// Prompt to tell the model to also generate an image prompt
const NO_IMAGE_CHANGE_SENTINEL = "NO IMAGE CHANGE";
const createImagePrompt = `

Finally, only create a prompt for DALL-E if the player entered a new room or location, or if they explicitly asked to look at something during this turn. Always treat the very first turn (the initial scenario) as a new location that requires an image prompt. Keep any prompt as short and concise as possible. This must always be the last sentence of your response and it must begin with IMAGE_PROMPT:. If nothing has changed and no look request was made, respond exactly with IMAGE_PROMPT: ${NO_IMAGE_CHANGE_SENTINEL}.`;

// Style prompt for the image, this is appended to all image prompts
const imageStyle =
	", pixelated, rendered like a mid 90s adventure game screenshot, amber gray-scale palette, no watermarks or text.";
const gameOverString =
	"You have reached the end of this game session. For now, games are limited to " +
	maxTurns +
	" turns but we'll be expanding on this in the future. Thanks for playing!";
const CREATE_GAME_SESSIONS_TABLE_QUERY = `
	CREATE TABLE IF NOT EXISTS game_sessions (
		game_key TEXT PRIMARY KEY,
		game_history JSONB NOT NULL,
		turn_count INTEGER NOT NULL DEFAULT 0,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);
`;
/* End Constants and Globals */

async function ensureDbInitialized() {
	if (!dbInitializationPromise) {
		dbInitializationPromise = pool.query(CREATE_GAME_SESSIONS_TABLE_QUERY).catch((error) => {
			dbInitializationPromise = null;
			console.error("Error initializing Postgres:", error);
			throw error;
		});
	}

	return dbInitializationPromise;
}

/* Routes */
app.post("/api/getAvailableGames", handleGetAvailableGames);
app.post("/api/generateNextTurn", handleGenerateNextTurn);
app.post("/api/generateImage", handleGenerateImage);
/* End Routes */

// Serve files from the public folder
app.use(express.static(join(__dirname, "public")));

async function handleGetAvailableGames(req, res) {
	try {
		const allFiles = await fs.readdir(promptPaths.gamesDir);
		const games = allFiles.filter((file) => {
			if (!VALID_SCENARIO_FILE_REGEX.test(file)) {
				return false;
			}

			const baseName = file.slice(0, -4);
			return baseName.length > 0 && baseName.length <= scenarioNameMaxLength;
		});
		res.json({ response: { games } });
	} catch (error) {
		console.error("Error returning game directory", error);
		res.status(500).json({ error: "An error occurred while processing your request." });
	}
}

async function handleGenerateNextTurn(req, res) {
	initializeSSE(res);

	try {
		const finalPayload = await streamGameTurn(req.body, res);
		sendSSE(res, { type: "complete", data: finalPayload });
	} catch (error) {
		console.error("Error generating a new turn:", error);
		const message = error?.message || "An error occurred while processing your request.";
		sendSSE(res, { type: "error", message });
	} finally {
		closeSSE(res);
	}
}

async function handleGenerateImage(req, res) {
	if (!createImages) {
		res.status(503).json({ error: "Image generation is currently disabled." });
		return;
	}

	const promptValidation = validateTextInput(req.body?.prompt, {
		fieldName: "Image prompt",
		maxLength: imagePromptMaxLength,
	});

	if (!promptValidation.valid) {
		res.status(400).json({ error: promptValidation.error });
		return;
	}

	initializeSSE(res);

	try {
		const { imageBuffer, imageAltText } = await streamOpenAIImage(promptValidation.value, (event) => {
			if (!event) {
				return;
			}

			switch (event.type) {
				case "status": {
					sendSSE(res, { type: "status", message: event.message });
					break;
				}
				case "progress": {
					sendSSE(res, { type: "progress", progress: event.progress });
					break;
				}
				default:
					break;
			}
		});

		if (!imageBuffer || !imageBuffer.length) {
			throw new Error("Image stream returned empty payload");
		}

		const base64Image = imageBuffer.toString("base64");
		sendSSE(res, {
			type: "complete",
			data: {
				image: base64Image,
				altText: convertToASCII(imageAltText),
			},
		});
	} catch (error) {
		console.error("Error generating image:", error);
		sendSSE(res, {
			type: "error",
			message: "An error occurred while generating the image.",
		});
	} finally {
		closeSSE(res);
	}
}

async function startServer() {
	try {
		await ensureDbInitialized();
		app.listen(config.port, () => {
			console.log(`Server is running on port ${config.port}`);
		});
	} catch (error) {
		console.error("Failed to initialize the database:", error);
		process.exit(1);
	}
}

startServer();

function initializeSSE(res) {
	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache, no-transform");
	res.setHeader("Connection", "keep-alive");

	if (typeof res.flushHeaders === "function") {
		res.flushHeaders();
	}
}

function sendSSE(res, payload) {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
	if (typeof res.flush === "function") {
		res.flush();
	}
}

function closeSSE(res) {
	res.write("data: [DONE]\n\n");
	res.end();
}

function buildConfig() {
	const env = process.env.NODE_ENV || "development";
	const port = parseInteger(process.env.PORT, 3000);
	const apiKey = process.env.API_KEY;

	if (!apiKey) {
		throw new Error("API_KEY environment variable is required to start the server");
	}

	const imageModel = process.env.IMAGE_MODEL || "gpt-image-1";
	const imageQuality = process.env.IMAGE_QUALITY || "low";
	const requestBodyLimit = process.env.REQUEST_JSON_LIMIT || "1mb";
	const promptMaxLength = parseInteger(process.env.MAX_PROMPT_LENGTH, 500);
	const imagePromptMaxLength = parseInteger(process.env.MAX_IMAGE_PROMPT_LENGTH, 400);
	const scenarioNameMaxLength = parseInteger(process.env.MAX_SCENARIO_LENGTH, 64);
	const rateLimitWindowMs = Math.max(parseInteger(process.env.RATE_LIMIT_WINDOW_MS, 60_000), 1_000);
	const rateLimitMax = Math.max(parseInteger(process.env.RATE_LIMIT_MAX, 60), 1);

	const database = {};
	if (process.env.DATABASE_URL) {
		database.connectionString = process.env.DATABASE_URL;
	}

	const sslFlag = (process.env.DATABASE_SSL || "").toLowerCase();
	const shouldUseSSL = sslFlag ? sslFlag === "true" || sslFlag === "1" : env === "production";
	if (shouldUseSSL) {
		const rejectUnauthorized = parseBoolean(process.env.DATABASE_SSL_REJECT_UNAUTHORIZED, false);
		database.ssl = { rejectUnauthorized };

		if (process.env.DATABASE_SSL_CA) {
			database.ssl.ca = process.env.DATABASE_SSL_CA;
		}
	}

	const promptsRoot = join(__dirname, "prompts");

	return {
		env,
		port,
		database,
		openAI: {
			apiKey,
			textModel: process.env.TEXT_MODEL || "gpt-4o",
			imageModel,
			imageSize: process.env.IMAGE_SIZE || "1536x1024",
			imageQuality,
		},
		game: {
			maxTurns: parseInteger(process.env.MAX_TURNS, 20),
			createImages: parseBoolean(process.env.CREATE_IMAGES, true),
			maxOutputTokens: parseInteger(process.env.MAX_OUTPUT_TOKENS, 1000),
			temperature: parseNumber(process.env.TEMPERATURE, 0.5),
			defaultScenario: process.env.DEFAULT_SCENARIO || "the_island",
		},
		prompts: {
			root: promptsRoot,
			gamesDir: join(promptsRoot, "games"),
			systemRules: join(promptsRoot, "system", "interactive_fiction.txt"),
		},
		limits: {
			requestBody: requestBodyLimit,
			prompt: promptMaxLength,
			imagePrompt: imagePromptMaxLength,
			scenarioName: scenarioNameMaxLength,
		},
		rateLimit: {
			windowMs: rateLimitWindowMs,
			max: rateLimitMax,
		},
	};
}

/* Methods */
async function streamGameTurn(requestBody, res) {
	await ensureDbInitialized();

	if (!requestBody || typeof requestBody !== "object") {
		throw new Error("Invalid request payload.");
	}

	const { gameKey: incomingGameKeyRaw, prompt, gameScenario } = requestBody;
	const gameKeyIsString = typeof incomingGameKeyRaw === "string";
	const incomingGameKey = gameKeyIsString ? incomingGameKeyRaw.trim() : incomingGameKeyRaw;

	if (incomingGameKey && (!gameKeyIsString || incomingGameKey.length > 128)) {
		throw new Error("Invalid game key provided.");
	}
	let gameKey = incomingGameKey;
	const gameTurnHistory = [];
	let currentTurnCount = 0;

	if (!incomingGameKey) {
		const scenarioFile = resolveScenarioFilename(gameScenario ?? defaultGameScenario);
		const [systemRulesPrompt, gameScenarioPrompt] = await Promise.all([
			loadPromptFromFile(promptPaths.systemRules),
			loadPromptFromFile(join(promptPaths.gamesDir, scenarioFile), promptPaths.gamesDir),
		]);

		gameTurnHistory.push({ role: "system", content: systemRulesPrompt });
		gameTurnHistory.push({ role: "user", content: gameScenarioPrompt });
	} else {
		const storedSession = await loadGameProgress(gameKey);

		if (!storedSession || !Array.isArray(storedSession.gameHistory)) {
			console.error("Game session not found for key", gameKey);
			return generateGameOverResponse(gameKey, "sessionNotFound", currentTurnCount);
		}

		gameTurnHistory.push(...storedSession.gameHistory);
		currentTurnCount = storedSession.turnCount || 0;

		if (currentTurnCount >= maxTurns) {
			return generateGameOverResponse(gameKey, "turnLimitExceeded", currentTurnCount);
		}

		const promptValidation = validateTextInput(prompt, {
			fieldName: "Prompt",
			maxLength: promptMaxLength,
		});

		if (!promptValidation.valid) {
			throw new Error(promptValidation.error);
		}

		const sanitizedPrompt = sanitize(promptValidation.value);
		if (!sanitizedPrompt) {
			throw new Error("Prompt must include at least one supported character.");
		}
		gameTurnHistory.push({ role: "user", content: sanitizedPrompt });
	}

	appendImageInstruction(gameTurnHistory);

	const headers = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${OPENAI_API_KEY}`,
	};

	const requestPayload = {
		model: textModel,
		input: formatHistoryForResponses(gameTurnHistory),
		max_output_tokens: numMaxTokens,
		temperature,
		stream: true,
	};

	const textResponse = await fetch(TEXT_API_URI, {
		method: "POST",
		headers,
		body: JSON.stringify(requestPayload),
	});

	if (!textResponse.ok) {
		if (textResponse.status === 429) {
			console.error("Error: OpenAI API quota exceeded");
			return generateGameOverResponse(gameKey, "APIQuotaExceeded", currentTurnCount);
		}

		const errorPayload = await textResponse.text();
		throw new Error(`OpenAI API error: ${errorPayload}`);
	}

	const aggregatedText = await streamOpenAIResponse(textResponse, (deltaText) => {
		if (deltaText) {
			sendSSE(res, { type: "delta", text: deltaText });
		}
	});

	if (!incomingGameKey) {
		gameKey = generateGameKey(aggregatedText.substring(0, 50));
		currentTurnCount = 1;
	} else {
		currentTurnCount++;
	}

	const trimmedResponse = aggregatedText.trim();
	gameTurnHistory.push({ role: "assistant", content: trimmedResponse });
	await saveGameProgress(gameKey, gameTurnHistory, currentTurnCount);

	const { textResponseBody, imagePrompt: extractedImagePrompt } = extractImagePrompt(trimmedResponse);
	const initialTurnFallbackPrompt =
		!extractedImagePrompt && currentTurnCount === 1 ? buildInitialImagePrompt(textResponseBody) : null;

	return {
		gameKey,
		turnCount: currentTurnCount,
		text: textResponseBody,
		imagePrompt: extractedImagePrompt || initialTurnFallbackPrompt,
	};
}

async function streamOpenAIResponse(response, onDelta) {
	if (!response.body) {
		throw new Error("OpenAI API returned an empty response body");
	}

	const decoder = new TextDecoder();
	let buffer = "";
	let aggregatedText = "";
	let streamClosed = false;

	const processChunk = (chunkText) => {
		buffer += chunkText;
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
					streamClosed = true;
					continue;
				}

				let parsed;
				try {
					parsed = JSON.parse(dataPayload);
				} catch (error) {
					console.error("Failed to parse streaming payload:", dataPayload);
					continue;
				}

				switch (parsed.type) {
					case "response.output_text.delta": {
						const deltaText = parsed.delta || "";
						aggregatedText += deltaText;
						if (typeof onDelta === "function") {
							onDelta(deltaText);
						}
						break;
					}
					case "response.completed": {
						streamClosed = true;
						break;
					}
					case "response.error": {
						throw new Error(parsed.error?.message || "OpenAI streaming error");
					}
					default:
						break;
				}
			}
		}
	};

	if (typeof response.body.getReader === "function") {
		const reader = response.body.getReader();
		while (!streamClosed) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			if (value) {
				const chunkText = typeof value === "string" ? value : decoder.decode(value, { stream: true });
				processChunk(chunkText);
			}
		}
	} else if (typeof response.body[Symbol.asyncIterator] === "function") {
		for await (const chunk of response.body) {
			const chunkText =
				typeof chunk === "string"
					? chunk
					: Buffer.isBuffer(chunk)
					? chunk.toString()
					: decoder.decode(chunk, { stream: true });

			processChunk(chunkText);

			if (streamClosed) {
				break;
			}
		}
	} else {
		throw new Error("OpenAI API returned a non-streaming body");
	}

	return aggregatedText.trim();
}

function appendImageInstruction(history) {
	if (!createImages || history.length === 0) {
		return;
	}

	const lastMessage = history[history.length - 1];
	if (!lastMessage || typeof lastMessage.content !== "string") {
		return;
	}

	const trimmedTrailingWhitespace = lastMessage.content.replace(/\s+$/, "");
	const needsTerminalPunctuation = trimmedTrailingWhitespace !== "" && !/[.!?]$/.test(trimmedTrailingWhitespace);
	const baseContent = needsTerminalPunctuation ? `${trimmedTrailingWhitespace}.` : trimmedTrailingWhitespace;
	lastMessage.content = `${baseContent}${createImagePrompt}`;
}

function resolveScenarioFilename(rawScenario) {
	const candidate = typeof rawScenario === "string" ? rawScenario.trim() : "";
	const scenarioName = candidate || defaultGameScenario;
	const normalized = scenarioName.endsWith(".txt") ? scenarioName : `${scenarioName}.txt`;

	if (!VALID_SCENARIO_FILE_REGEX.test(normalized)) {
		throw new Error("Invalid scenario name provided.");
	}

	const baseName = normalized.slice(0, -4);
	if (!baseName || baseName.length > scenarioNameMaxLength) {
		throw new Error("Invalid scenario name provided.");
	}

	return normalized;
}

function extractImagePrompt(responseText) {
	const segments = responseText.split("IMAGE_PROMPT");
	const textResponseBody = segments[0] ? segments[0].trim() : responseText;

	if (segments.length <= 1) {
		return { textResponseBody, imagePrompt: null };
	}

	const imagePrompt = segments
		.slice(1)
		.join("IMAGE_PROMPT")
		.replace(/^[:\s]+/, "")
		.trim();

	if (!imagePrompt) {
		return { textResponseBody, imagePrompt: null };
	}

	const normalized = imagePrompt.replace(/[.!?\s]+$/u, "").toUpperCase();
	if (normalized.startsWith(NO_IMAGE_CHANGE_SENTINEL)) {
		return { textResponseBody, imagePrompt: null };
	}

	return { textResponseBody, imagePrompt };
}

function buildInitialImagePrompt(responseText) {
	if (!responseText || typeof responseText !== "string") {
		return null;
	}

	const condensed = responseText.replace(/\s+/g, " ").trim();
	if (!condensed) {
		return null;
	}

	const sentenceMatch = condensed.match(/^[^.!?]+[.!?]?/);
	const baseDescription = (sentenceMatch ? sentenceMatch[0] : condensed).trim();
	if (!baseDescription) {
		return null;
	}

	const truncated = baseDescription.length > 200 ? `${baseDescription.slice(0, 200).trim()}...` : baseDescription;
	return `Adventure game scene: ${truncated}`;
}

async function streamOpenAIImage(prompt, notify) {
	if (!createImages) {
		return { imageBuffer: Buffer.alloc(0), imageAltText: "" };
	}

	const trimmedPrompt = typeof prompt === "string" ? prompt.trim() : "";
	if (!trimmedPrompt) {
		return { imageBuffer: Buffer.alloc(0), imageAltText: "" };
	}

	const promptWithoutTrailingPunctuation = trimmedPrompt.replace(/[.!?]+$/u, "");
	const combinedPrompt = `${promptWithoutTrailingPunctuation}${imageStyle}`.replace(/^[:\s]+/, "");
	const sanitizedPrompt = sanitize(combinedPrompt);

	if (!sanitizedPrompt) {
		return { imageBuffer: Buffer.alloc(0), imageAltText: trimmedPrompt };
	}

	const headers = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${OPENAI_API_KEY}`,
	};

	const requestPayload = {
		model: IMAGE_MODEL,
		prompt: sanitizedPrompt,
		size: IMAGE_SIZE,
		stream: true,
	};

	if (IMAGE_QUALITY) {
		requestPayload.quality = IMAGE_QUALITY;
	}

	if (typeof notify === "function") {
		notify({ type: "status", message: "Generating image..." });
	}

	const imageResponse = await fetch(IMAGE_API_URI, {
		method: "POST",
		headers,
		body: JSON.stringify(requestPayload),
	});

	if (!imageResponse.ok) {
		const errorPayload = await imageResponse.text();
		console.error("OpenAI image API error:", errorPayload);
		throw new Error("Invalid response from OpenAI image API");
	}

	if (!imageResponse.body) {
		throw new Error("OpenAI image API returned an empty body");
	}

	const decoder = new TextDecoder();
	let buffer = "";
	const base64Chunks = [];
	let altText = trimmedPrompt;
	let chunkCounter = 0;
	let streamClosed = false;
	let reader = null;

	const processPayload = (payload) => {
		if (!payload || typeof payload !== "object") {
			return;
		}

		if (payload.status && typeof notify === "function") {
			notify({ type: "status", message: payload.status });
		}

		if (payload.progress && typeof notify === "function") {
			notify({ type: "progress", progress: payload.progress });
		}

		const candidates = [];
		if (Array.isArray(payload.data)) {
			candidates.push(...payload.data);
		}

		if (payload.output) {
			const outputArray = Array.isArray(payload.output) ? payload.output : [payload.output];
			candidates.push(...outputArray);
		}

		if (payload.image) {
			candidates.push(payload.image);
		}

		for (const candidate of candidates) {
			if (candidate && typeof candidate === "object") {
				if (candidate.b64_json) {
					base64Chunks.push(candidate.b64_json);
					chunkCounter++;
					if (typeof notify === "function") {
						notify({ type: "progress", progress: Math.min(chunkCounter * 25, 95) });
					}
				}
				if (!altText && candidate.revised_prompt) {
					altText = candidate.revised_prompt;
				}
				if (candidate.image_b64) {
					base64Chunks.push(candidate.image_b64);
				}
			}
		}

		if (payload.revised_prompt && (!altText || altText === trimmedPrompt)) {
			altText = payload.revised_prompt;
		}

		if (payload.b64_json) {
			base64Chunks.push(payload.b64_json);
		}
	};

	const processChunk = (chunkValue) => {
		const chunkText =
			typeof chunkValue === "string"
				? chunkValue
				: Buffer.isBuffer(chunkValue)
				? chunkValue.toString()
				: decoder.decode(chunkValue, { stream: true });

		buffer += chunkText;
		const events = buffer.split("\n\n");
		buffer = events.pop() || "";

		for (const eventChunk of events) {
			const eventLines = eventChunk
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line);

			for (const line of eventLines) {
				if (line === "data: [DONE]") {
					streamClosed = true;
					break;
				}

				if (!line.startsWith("data:")) {
					continue;
				}

				const jsonPayload = line.slice(5).trim();

				if (!jsonPayload || jsonPayload === "[DONE]") {
					continue;
				}

				try {
					const parsed = JSON.parse(jsonPayload);
					processPayload(parsed);
				} catch (error) {
					console.error("Failed to parse streaming image payload:", jsonPayload);
				}
			}

			if (streamClosed) {
				break;
			}
		}
	};

	if (typeof imageResponse.body?.getReader === "function") {
		reader = imageResponse.body.getReader();
		while (!streamClosed) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			if (!value) {
				continue;
			}
			processChunk(value);
		}
	} else if (typeof imageResponse.body?.[Symbol.asyncIterator] === "function") {
		for await (const chunk of imageResponse.body) {
			processChunk(chunk);
			if (streamClosed) {
				break;
			}
		}
	} else {
		throw new Error("OpenAI image API returned an unsupported body type");
	}

	if (reader && typeof reader.cancel === "function") {
		await reader.cancel().catch(() => {});
	}

	if (typeof notify === "function") {
		notify({ type: "status", message: "Finalizing image..." });
	}

	if (!base64Chunks.length) {
		throw new Error("Image stream did not return any image data");
	}

	const imageBuffer = Buffer.from(base64Chunks.join(""), "base64");

	return {
		imageBuffer,
		imageAltText: altText || trimmedPrompt,
	};
}

function generateGameKey(gameScenarioString) {
	// Create the key for this session based on the initial scenario
	// Take the first 50 characters of the first custom game response
	// (e.g. you are on a beach) as there *should* always been unique
	const gameScenario = gameScenarioString;
	const hash = crypto.createHash("sha256");
	hash.update(gameScenario);
	const gameKey = "game_" + hash.digest("hex");

	return gameKey;
}

function formatHistoryForResponses(history) {
	return history.map((entry) => {
		const contentType = entry.role === "assistant" ? "output_text" : "input_text";
		return {
			role: entry.role,
			content: [{ type: contentType, text: entry.content }],
		};
	});
}

function generateGameOverResponse(gameKey, reason, turnCount = 0) {
	let response = {};
	response.gameKey = gameKey;
	response.turnCount = turnCount;
	response.gameOver = "true";

	switch (reason) {
		case "turnLimitExceeded":
			response.text = gameOverString;
			break;
		case "APIQuotaExceeded":
			response.text =
				"Due to the immense popularity of this game we have exceeded our capacity! Unfortunately it's game over for now, but we're working hard on recruiting more gnomes to power the AI machinery... Check back soon :)";
			break;
		case "sessionNotFound":
			response.text = "We couldn't find that game session. Please start a new adventure to continue playing.";
			break;
		default:
			response.text =
				"ERROR: Something went wrong and you have encountered some weird and unknown bug. Check back soon, maybe it's fixed. Or maybe it's not. Welcome to our probabilistic future.";
			break;
	}

	return response;
}

async function saveGameProgress(gameKey, gameHistory, turnCount) {
	const gameHistoryJSON = JSON.stringify(gameHistory);

	try {
		await pool.query(
			`INSERT INTO game_sessions (game_key, game_history, turn_count)
			VALUES ($1, $2::jsonb, $3)
			ON CONFLICT (game_key)
			DO UPDATE SET game_history = EXCLUDED.game_history, turn_count = EXCLUDED.turn_count, updated_at = NOW()`,
			[gameKey, gameHistoryJSON, turnCount]
		);
	} catch (error) {
		console.error("Error saving game progress to Postgres:", error);
	}
}

async function loadGameProgress(gameKey) {
	try {
		const result = await pool.query("SELECT game_history, turn_count FROM game_sessions WHERE game_key = $1", [
			gameKey,
		]);

		if (result.rows.length === 0) {
			return null;
		}

		const row = result.rows[0];
		const rawHistory = row.game_history;
		let gameHistory;

		if (Array.isArray(rawHistory)) {
			gameHistory = rawHistory;
		} else if (typeof rawHistory === "string") {
			gameHistory = JSON.parse(rawHistory);
		} else if (rawHistory && typeof rawHistory === "object") {
			gameHistory = rawHistory;
		} else {
			gameHistory = [];
		}

		return { gameHistory, turnCount: row.turn_count || 0 };
	} catch (error) {
		console.error("Error retrieving game progress from Postgres:", error);
	}
	return null;
}

async function loadPromptFromFile(filePath, allowedRoot = promptPaths.root) {
	try {
		const safePath = ensurePathWithinRoot(filePath, allowedRoot);
		const content = await fs.readFile(safePath, "utf8");
		return content;
	} catch (error) {
		console.error(`Failed to load prompt file at ${filePath}`, error);
		throw error;
	}
}

/* Helper Methods */
function ensurePathWithinRoot(targetPath, rootDir) {
	const normalizedRoot = resolve(rootDir);
	const normalizedTarget = resolve(targetPath);
	const relativePath = relative(normalizedRoot, normalizedTarget);

	if (relativePath === "") {
		return normalizedTarget;
	}

	const segments = relativePath.split(sep);
	const hasTraversalSegment = segments.some((segment) => segment === ".." || segment.startsWith(".."));
	if (relativePath.startsWith("..") || hasTraversalSegment) {
		throw new Error("Attempted to access a file outside of the permitted directory.");
	}

	return normalizedTarget;
}

function validateTextInput(value, { fieldName = "Value", maxLength } = {}) {
	const trimmed = typeof value === "string" ? value.trim() : "";

	if (!trimmed) {
		return { valid: false, error: `${fieldName} is required.` };
	}

	if (typeof maxLength === "number" && trimmed.length > maxLength) {
		return { valid: false, error: `${fieldName} must be ${maxLength} characters or fewer.` };
	}

	return { valid: true, value: trimmed };
}

function parseInteger(value, defaultValue) {
	if (value == null) {
		return defaultValue;
	}

	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseNumber(value, defaultValue) {
	if (value == null) {
		return defaultValue;
	}

	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseBoolean(value, defaultValue) {
	if (value == null) {
		return defaultValue;
	}

	return /^(true|1|yes|y)$/i.test(value);
}

// It does what it says on the tin
function convertToASCII(str) {
	if (typeof str !== "string") {
		return "";
	}

	return str.replace(/[^\x00-\x7F]/g, "");
}

// Best (quick) effort at removing any potentially dangerous strings from user input
function sanitize(str) {
	if (typeof str !== "string") {
		return "";
	}

	const withoutControlCharacters = str.replace(/[\u0000-\u001F\u007F]+/g, "");
	const withoutHtml = withoutControlCharacters.replace(/<[^>]*>/g, "");
	return withoutHtml.trim();
}
/* End Helper Methods */
