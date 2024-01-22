import express from "express";
import { fileURLToPath } from "url";
import { dirname } from "path";
import fetch from "node-fetch";
import fs from "fs/promises";
import session from "express-session";
import dotenv from "dotenv";
import crypto from "crypto";
import redis from "redis";

if (process.env.NODE_ENV !== "production") {
	dotenv.config({ path: "./config.env" });
}

// Initialize things
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const port = process.env.PORT || 3000;
let turnCount = 0;

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

/* Constants and Globals */
const maxTurns = 10; //default: 10
const createImages = true; //default: true
const numMaxTokens = 1000; //default: 1000
const temperature = 0.5; //default: 0.5
const model = "gpt-4"; //default: gpt-3.5-turbo
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
	", no watermarks or text in the image, black and white only, in the style of an adventure game from the 1980s as pixel art.";
const gameOverString =
	"You have reached the end of this game session. For now, games are limited to " +
	maxTurns +
	" turns but we'll be expanding on this in the future. Thanks for playing!";
/* End Constants and Globals */

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

// Get the Reddis URL and then create the Redis client for managing game state
const redisClient = redis.createClient({
	url: process.env.REDIS_TLS_URL,
	socket: {
		tls: true,
		rejectUnauthorized: false,
	},
});

// Start the server
app.listen(port, () => {
	console.log(`Server is running on port ${port}`);
});

/* Methods */
async function startGame(gameScenario) {
	console.log("Starting New Game");
	await connectRedisClient();

	turnCount = null;

	if (gameScenario == null) gameScenario = defaultGameScenario;

	systemRulesPrompt = await loadPromptFromFile(promptFilePath + systemPromptPath + ".txt");
	gameScenarioPrompt = await loadPromptFromFile(promptFilePath + "games/" + gameScenario);

	let response = generateNextTurn(); // If no gameKey or command are sent, create a new game
	return response;
}

async function generateNextTurn(gameKey, prompt) {
	// If the turn count is maxed, then it's game over. Cuz this shit is expensive...
	if (turnCount >= maxTurns) {
		return generateGameOverReponse(gameKey, "turnLimitExceeded");
	}

	const headers = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${OPENAI_API_KEY}`,
	};

	let gameTurnHistory = [];

	if (gameKey == null) {
		// If no gameKey is sent, create a new game
		gameTurnHistory.push({ role: "system", content: systemRulesPrompt }); // Now add in the system prompt
		gameTurnHistory.push({ role: "user", content: gameScenarioPrompt }); // Send the game scenario creation prompt
	} else {
		gameTurnHistory = await loadGameProgress(gameKey); // Get the history of game turns to date. We need to send the complete history to the API to maintain state
		prompt = sanitize(prompt); // Do a quick (and crude) check to make sure there are no security issues in the prompt
		let formattedPrompt = { role: "user", content: prompt }; // Format the command so we can send to the model API
		gameTurnHistory.push(formattedPrompt); // Finally add the new command
	}

	if (createImages) {
		gameTurnHistory[gameTurnHistory.length - 1].content += ". " + createImagePrompt; // Append the "createImagePrompt" prompt to the final prompt, so we can have nice fancy image
	}

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
				// API Quota exceeded. Send a game over message and terminate the game
				console.error("Error: Open AI API quota exceeded");
				return generateGameOverReponse(gameKey, "APIQuotaExceeded");
				break;
			default:
				console.error("Error: Something went wrong, probably with how the OpenAI API was called.");
				return generateGameOverReponse(gameKey);
				break;
		}
	}

	// If there was no gameKey, make one as it's a new game
	if (gameKey == null) {
		// The gameKey is based on the first 50 characters of the rendered game scenario
		gameKey = generateGameKey(textData.choices[0].message.content.substring(0, 50));
		turnCount = 1;
	} else {
		turnCount++;
	}

	// Split the text response so we can get the image prompt out
	const substrs = textData.choices[0].message.content.split("IMAGE_PROMPT");
	let response = {};
	response.gameKey = gameKey; // Return the key back to the client, every time. It will need it to maintain state.
	response.turnCount = turnCount;
	response.text = substrs[0];
	response.imagePrompt = substrs[1];

	// update the game state file. Remove the system prompt and add the most recent assistant response
	gameTurnHistory.push({ role: "assistant", content: textData.choices[0].message.content });
	await saveGameProgress(gameKey, gameTurnHistory);

	return response;
}

async function generateImage(prompt) {
	if (createImages == true && prompt != null) {
		// Clean up the prompt in a lazy way (I will fix this eventually)
		prompt = prompt.slice(0, -1) + imageStyle;
		prompt = prompt.substring(2);
		prompt = sanitize(prompt); // Do a quick (and crude) check to make sure there are no security issues in the prompt

		const headers = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${OPENAI_API_KEY}`,
		};

		const imageRequestBody = JSON.stringify({
			model: "dall-e-3",
			prompt: prompt,
			num_images: 1,
			size: "1024x1024",
			response_format: "url",
		});

		const imageResponse = await fetch(IMAGE_API_URI, {
			method: "POST",
			headers: headers,
			body: imageRequestBody,
		});

		const imageData = await imageResponse.json();
		console.log(imageData);

		if (!imageData.data || imageData.data.length === 0) {
			console.error("Unexpected API response:", data.image);
			throw new Error("Invalid response from DALL-E API");
		}

		const imageBufferResponse = await fetch(imageData.data[0].url);
		const imageBuffer = await imageBufferResponse.arrayBuffer();

		let payload = {};
		payload.image = Buffer.from(imageBuffer);
		payload.imageAltText = prompt;

		return payload;
	} else {
		return null;
	}
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

function generateGameOverReponse(gameKey, reason) {
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
		default:
			response.text =
				"Hmm. Something went wrong and we're not quite sure what it is. Check back soon, maybe it's fixed. Or maybe it's not. Welcome to our probalistic future :)";
			break;
	}

	return response;
}

async function saveGameProgress(gameKey, gameHistory) {
	const gameHistoryJSON = JSON.stringify(gameHistory);

	try {
		const reply = await redisClient.set(gameKey, gameHistoryJSON);
	} catch (error) {
		console.error("Error saving game progress to Redis:", error);
	}
	return;
}

async function loadGameProgress(gameKey) {
	try {
		const gameHistoryJSON = await redisClient.get(gameKey);
		const gameHistory = JSON.parse(gameHistoryJSON);

		return gameHistory;
	} catch (error) {
		console.error("Error retrieving game progress from Redis:", error);
	}
	return;
}

async function loadPromptFromFile(filePath) {
	try {
		const content = await fs.readFile(filePath, "utf8");
		return content;
	} catch (error) {
		throw error;
	}
}

async function connectRedisClient() {
	redisClient.connect().catch((error) => {});

	redisClient.on("connect", function () {
		console.log("Connected to Redis!");
	});

	redisClient.on("error", function (error) {
		console.error("Error connecting to Redis:", error);
	});
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
