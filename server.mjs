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
const shouldUseSSL = sslFlag
	? sslFlag === "true" || sslFlag === "1"
	: process.env.NODE_ENV === "production";

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
const TEXT_API_URI = "https://api.openai.com/v1/chat/completions";
const IMAGE_API_URI = "https://api.openai.com/v1/images/generations";
const IMAGE_MODEL = process.env.IMAGE_MODEL || "dall-e-3";
const IMAGE_SIZE = process.env.IMAGE_SIZE || "1024x1024";
const IMAGE_QUALITY =
	process.env.IMAGE_QUALITY || (IMAGE_MODEL === "gpt-image-1" ? "high" : "standard");

/* Constants and Globals */
const maxTurns = 20;
const createImages = true; //default: true
const numMaxTokens = 1000; //default: 1000
const temperature = 0.5; //default: 0.5
const model = "gpt-4";
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

app.post("/api/startGame", async (req, res) => {
	try {
		const gameScenario = req.body.gameScenario;

		const response = await startGame(gameScenario);
		res.send({ response });
	} catch (error) {
		console.error("Error starting the game", error);
		res.status(500).send({ error: "An error occurred while processing your request." });
	}
});

app.post("/api/generateNextTurn", async (req, res) => {
	const gameKey = req.body.gameKey;
	const prompt = req.body.prompt;

	try {
		const response = await generateNextTurn(gameKey, prompt);
		res.type("application/json");
		res.send({ response });
	} catch (error) {
		console.error("Error generating a new turn:", error);
		res.status(500).send({ error: "An error occurred while processing your request." });
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
async function startGame(gameScenario) {
	console.log("Starting New Game");
	await ensureDbInitialized();

	if (gameScenario == null) gameScenario = defaultGameScenario;

	systemRulesPrompt = await loadPromptFromFile(promptFilePath + systemPromptPath + ".txt");
	gameScenarioPrompt = await loadPromptFromFile(promptFilePath + "games/" + gameScenario);

	return generateNextTurn(); // If no gameKey or command are sent, create a new game
}

async function generateNextTurn(gameKey, prompt) {
	await ensureDbInitialized();

	let currentTurnCount = 0;
	let gameTurnHistory = [];
	let isExistingGame = false;

	if (gameKey == null) {
		// If no gameKey is sent, create a new game
		gameTurnHistory.push({ role: "system", content: systemRulesPrompt });
		gameTurnHistory.push({ role: "user", content: gameScenarioPrompt });
	} else {
		isExistingGame = true;
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

	const textRequestBody = JSON.stringify({
		model: model,
		messages: gameTurnHistory,
		max_tokens: numMaxTokens,
		n: 1,
		stop: null,
		temperature: temperature,
	});

	const textResponse = await fetch(TEXT_API_URI, {
		method: "POST",
		headers: headers,
		body: textRequestBody,
	});

	const textData = await textResponse.json();

	if (!textData.choices || textData.choices.length === 0) {
		console.error("Unexpected API response:", textData);

		switch (textData.code) {
			case "429":
				console.error("Error: Open AI API quota exceeded");
				return generateGameOverReponse(gameKey, "APIQuotaExceeded", currentTurnCount);
			default:
				console.error(
					"Error: Something went wrong, probably with how the OpenAI API was called."
				);
				return generateGameOverReponse(gameKey, undefined, currentTurnCount);
		}
	}

	if (!isExistingGame) {
		// The gameKey is based on the first 50 characters of the rendered game scenario
		gameKey = generateGameKey(textData.choices[0].message.content.substring(0, 50));
		currentTurnCount = 1;
	} else {
		currentTurnCount++;
	}

	// Split the text response so we can get the image prompt out
	const substrs = textData.choices[0].message.content.split("IMAGE_PROMPT");
	let response = {};
	response.gameKey = gameKey;
	response.turnCount = currentTurnCount;
	response.text = substrs[0];
	response.imagePrompt = substrs[1];

	gameTurnHistory.push({ role: "assistant", content: textData.choices[0].message.content });
	await saveGameProgress(gameKey, gameTurnHistory, currentTurnCount);

	return response;
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
			response.text =
				"We couldn't find that game session. Please start a new adventure to continue playing.";
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
		const result = await pool.query(
			"SELECT game_history, turn_count FROM game_sessions WHERE game_key = $1",
			[gameKey]
		);

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
