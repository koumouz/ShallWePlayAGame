import express from "express";
import { fileURLToPath } from "url";
import { dirname } from "path";
import fetch from "node-fetch";
import fs from "fs/promises";
import session from "express-session";
import dotenv from "dotenv";
import crypto from "crypto";
import pkg from "pg";

const { Pool } = pkg;

if (process.env.NODE_ENV !== "production") {
	dotenv.config({ path: "./config.env" });
}

// Initialize things
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const port = process.env.PORT || 3000;

const databaseConfig = {};

if (process.env.DATABASE_URL) {
	databaseConfig.connectionString = process.env.DATABASE_URL;
}

const sslFlag = (process.env.DATABASE_SSL || "").toLowerCase();
const shouldUseSSL = sslFlag ? sslFlag === "true" || sslFlag === "1" : process.env.NODE_ENV === "production";

if (shouldUseSSL) {
	databaseConfig.ssl = { rejectUnauthorized: false };
}

const pool = new Pool(databaseConfig);

let dbInitialized = false;

app.use(express.json({ limit: "50mb" }));
app.use(
	session({
		secret: process.env.SESSION_SECRET,
		resave: false,
		saveUninitialized: true,
		cookie: { secure: false },
	})
);

/* OpenAI API Endpoints */
const OPENAI_API_KEY = process.env.API_KEY;
const TEXT_API_URI = "https://api.openai.com/v1/responses";
const IMAGE_API_URI = "https://api.openai.com/v1/images/generations";

/* Constants and Globals */
const maxTurns = 35;
const createImages = true; //default: true
const numMaxTokens = 1000; //default: 1000
const temperature = 0.5; //default: 0.5
const textModel = process.env.TEXT_MODEL || "gpt-4o";
const IMAGE_MODEL = process.env.IMAGE_MODEL || "dall-e-3";
const IMAGE_SIZE = process.env.IMAGE_SIZE || "1024x1024";
const IMAGE_QUALITY = process.env.IMAGE_QUALITY || (IMAGE_MODEL === "gpt-image-1" ? "high" : "standard");
const defaultGameScenario = "the_island";

// Game Rules
const promptFilePath = "prompts/";
const systemPromptPath = "system/interactive_fiction";
let systemRulesPrompt = null;
let gameScenarioPrompt = null;

// Prompt to tell the model to also generate an image prompt
const createImagePrompt =
	"\n\nFinally, create a prompt for DALL-E to create an image of the scene you just described. Keep the prompt as short and concise as possible. This should always be the last sentence of your response and it should begin with IMAGE_PROMPT:";

// Style prompt for the image, this is appended to all image prompts
const imageStyle =
	", no watermarks or text in the image, no colors, monochrome, black and white, in the style of an adventure game from the 1980s as pixel art.";
const gameOverString =
	"You have reached the end of this game session. For now, games are limited to " +
	maxTurns +
	" turns but we'll be expanding on this in the future. Thanks for playing!";
/* End Constants and Globals */

async function ensureDbInitialized() {
	if (dbInitialized) {
		return;
	}

	const createTableQuery = `
		CREATE TABLE IF NOT EXISTS game_sessions (
			game_key TEXT PRIMARY KEY,
			game_history JSONB NOT NULL,
			turn_count INTEGER NOT NULL DEFAULT 0,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
	`;

	try {
		await pool.query(createTableQuery);
		dbInitialized = true;
	} catch (error) {
		console.error("Error initializing Postgres:", error);
		throw error;
	}
}

/* Routes */
app.post("/api/getAvailableGames", async (req, res) => {
	try {
		// Read the game prompts directory and return an array of strings for the available games to play
		const response = {};
		const allFiles = await fs.readdir(promptFilePath + "games/");
		response.games = allFiles.filter((file) => !file.startsWith("."));
		res.send({ response });
	} catch (error) {
		console.error("Error returning game direcrory", error);
		res.status(500).send({ error: "An error occurred while processing your request." });
	}
});

app.post("/api/generateNextTurn", async (req, res) => {
	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache, no-transform");
	res.setHeader("Connection", "keep-alive");

	if (typeof res.flushHeaders === "function") {
		res.flushHeaders();
	}

	try {
		const finalPayload = await streamGameTurn(req.body, res);
		res.write(`data: ${JSON.stringify({ type: "complete", data: finalPayload })}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
	} catch (error) {
		console.error("Error generating a new turn:", error);
		const message = error?.message || "An error occurred while processing your request.";
		res.write(`data: ${JSON.stringify({ type: "error", message: message })}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
	}
});

app.post("/api/generateImage", async (req, res) => {
	const prompt = req.body.prompt;

	if (createImages) {
		try {
			const imagePayload = await generateImage(prompt);
			res.type("image/png");
			res.set("X-Image-Alt-Text", convertToASCII(imagePayload.imageAltText));
			res.send(imagePayload.image);
		} catch (error) {
			console.error("Error generating image:", error);
			res.status(500).send({ error: "An error occurred while generating the image." });
		}
	}
});
/* End Routes */

// Serve files from the public folder
app.use(express.static(__dirname + "/public"));

async function startServer() {
	try {
		await ensureDbInitialized();
		app.listen(port, () => {
			console.log(`Server is running on port ${port}`);
		});
	} catch (error) {
		console.error("Failed to initialize the database:", error);
		process.exit(1);
	}
}

startServer();

/* Methods */
async function streamGameTurn(requestBody, res) {
	await ensureDbInitialized();

	let { gameKey, prompt, gameScenario } = requestBody || {};
	let gameTurnHistory = [];
	let currentTurnCount = 0;
	const isExistingGame = Boolean(gameKey);

	if (!isExistingGame) {
		if (gameScenario == null) {
			gameScenario = defaultGameScenario;
		}

		systemRulesPrompt = await loadPromptFromFile(promptFilePath + systemPromptPath + ".txt");
		gameScenarioPrompt = await loadPromptFromFile(promptFilePath + "games/" + gameScenario);

		gameTurnHistory.push({ role: "system", content: systemRulesPrompt });
		gameTurnHistory.push({ role: "user", content: gameScenarioPrompt });
	} else {
		const storedSession = await loadGameProgress(gameKey);

		if (!storedSession || !Array.isArray(storedSession.gameHistory)) {
			console.error("Game session not found for key", gameKey);
			return generateGameOverReponse(gameKey, "sessionNotFound", currentTurnCount);
		}

		gameTurnHistory = storedSession.gameHistory;
		currentTurnCount = storedSession.turnCount || 0;

		if (currentTurnCount >= maxTurns) {
			return generateGameOverReponse(gameKey, "turnLimitExceeded", currentTurnCount);
		}

		const sanitizedPrompt = sanitize(typeof prompt === "string" ? prompt : "");
		const formattedPrompt = { role: "user", content: sanitizedPrompt };
		gameTurnHistory.push(formattedPrompt);
	}

	if (createImages && gameTurnHistory.length > 0) {
		gameTurnHistory[gameTurnHistory.length - 1].content += ". " + createImagePrompt;
	}

	const headers = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${OPENAI_API_KEY}`,
	};

	const requestPayload = {
		model: textModel,
		input: formatHistoryForResponses(gameTurnHistory),
		max_output_tokens: numMaxTokens,
		temperature: temperature,
		stream: true,
	};

	const textResponse = await fetch(TEXT_API_URI, {
		method: "POST",
		headers: headers,
		body: JSON.stringify(requestPayload),
	});

	if (!textResponse.ok) {
		if (textResponse.status === 429) {
			console.error("Error: OpenAI API quota exceeded");
			return generateGameOverReponse(gameKey, "APIQuotaExceeded", currentTurnCount);
		}

		const errorPayload = await textResponse.text();
		throw new Error(`OpenAI API error: ${errorPayload}`);
	}

	if (!textResponse.body) {
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
						res.write(`data: ${JSON.stringify({ type: "delta", text: deltaText })}\n\n`);
						if (typeof res.flush === "function") {
							res.flush();
						}
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

	if (typeof textResponse.body?.getReader === "function") {
		const reader = textResponse.body.getReader();
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
	} else if (textResponse.body && typeof textResponse.body[Symbol.asyncIterator] === "function") {
		for await (const chunk of textResponse.body) {
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

	aggregatedText = aggregatedText.trim();

	if (!isExistingGame) {
		gameKey = generateGameKey(aggregatedText.substring(0, 50));
		currentTurnCount = 1;
	} else {
		currentTurnCount++;
	}

	gameTurnHistory.push({ role: "assistant", content: aggregatedText });
	await saveGameProgress(gameKey, gameTurnHistory, currentTurnCount);

	const substrs = aggregatedText.split("IMAGE_PROMPT");
	const textResponseBody = substrs[0] ? substrs[0].trim() : aggregatedText;
	let imagePrompt = null;
	if (substrs.length > 1) {
		imagePrompt = substrs[1].replace(/^[:\s]+/, "").trim();
	}

	return {
		gameKey,
		turnCount: currentTurnCount,
		text: textResponseBody,
		imagePrompt,
	};
}

async function generateImage(prompt) {
	if (!createImages || !prompt) {
		return null;
	}

	let imagePrompt = prompt;
	const originalPrompt = imagePrompt;

	if (imagePrompt.length > 0) {
		imagePrompt = imagePrompt.slice(0, -1);
	}

	imagePrompt += imageStyle;

	imagePrompt = imagePrompt.replace(/^[:\s]+/, "");
	imagePrompt = sanitize(imagePrompt);

	const headers = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${OPENAI_API_KEY}`,
	};

	const requestPayload = {
		model: IMAGE_MODEL,
		prompt: imagePrompt,
		size: IMAGE_SIZE,
	};

	if (IMAGE_QUALITY) {
		requestPayload.quality = IMAGE_QUALITY;
	}

	const imageRequestBody = JSON.stringify(requestPayload);

	const imageResponse = await fetch(IMAGE_API_URI, {
		method: "POST",
		headers: headers,
		body: imageRequestBody,
	});

	if (!imageResponse.ok) {
		const errorPayload = await imageResponse.text();
		console.error("OpenAI image API error:", errorPayload);
		throw new Error("Invalid response from OpenAI image API");
	}

	const imageData = await imageResponse.json();

	if (!imageData?.data?.length) {
		console.error("Unexpected image API response payload", imageData);
		throw new Error("Invalid response from OpenAI image API");
	}

	let imageBuffer;

	if (imageData.data[0].b64_json) {
		imageBuffer = Buffer.from(imageData.data[0].b64_json, "base64");
	} else if (imageData.data[0].url) {
		const imageBufferResponse = await fetch(imageData.data[0].url);
		const arrayBuffer = await imageBufferResponse.arrayBuffer();
		imageBuffer = Buffer.from(arrayBuffer);
	} else {
		console.error("Unexpected image data payload", imageData.data[0]);
		throw new Error("Invalid response from OpenAI image API");
	}

	return {
		image: imageBuffer,
		imageAltText: originalPrompt?.trim() || imagePrompt,
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

function generateGameOverReponse(gameKey, reason, turnCount = 0) {
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
				"Do to the immense popularity of this game we have exceeded our capacity! Unfortunately it's game over for now, but we're working hard on recruiting more gnomes to power the AI machinery... Check back soon :)";
			break;
		case "sessionNotFound":
			response.text = "We couldn't find that game session. Please start a new adventure to continue playing.";
			break;
		default:
			response.text =
				"ERROR: Something went wrong and you have encounted some weird and unknown bug. Check back soon, maybe it's fixed. Or maybe it's not. Welcome to our probabilistic future.";
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

async function loadPromptFromFile(filePath) {
	try {
		const content = await fs.readFile(filePath, "utf8");
		return content;
	} catch (error) {
		throw error;
	}
}

/* Helper Methods */
// It does what it says on the tin
function convertToASCII(str) {
	return str.replace(/[^\x00-\x7F]/g, "");
}

// Best (quick) effort at removing any potentially dangerous strings from user input
function sanitize(str) {
	// Remove potential HTML elements
	str = str.replace(/<[^>]*>/g, "");

	// Remove potential ECMAScript method calls
	str = str.replace(/\./g, "");

	// Remove single quotes
	str = str.replace(/'/g, "");

	return str;
}
/* End Helper Methods */
