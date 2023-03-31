import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import session from 'express-session';
import dotenv from 'dotenv';
import crypto from 'crypto';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: './config.env' });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }, // Change to `true` if using HTTPS
  })
);

/*
// Middleware to protect game.html
app.use('/game.html', (req, res, next) => {
  if (req.session.authenticated) {
    next();
  } else {
    res.redirect('/');
  }
});
*/

app.use(express.static(__dirname + '/public')); // Serve files from the public folder

/* Core Prompts and Knobs*/

/* OpenAI API */
const apiKey = process.env.API_KEY;
const textAPIURL = 'https://api.openai.com/v1/chat/completions';
const imageAPIURL = 'https://api.openai.com/v1/images/generations';
/* End OpenAI API */

// Game Rules
let systemRulesPrompt = await loadPromptFromFile('gamePrompts/interactive_fiction_system.txt');
let gameScenarioPrompt = await loadPromptFromFile('gamePrompts/the_island-v3.1.txt');

// Prompt to tell the model to also generate an image prompt
const createImagePrompt = "Additionally, write a prompt for image that looks like the current scene you just described. This should always be the last sentence of your response and it should begin with IMAGE_PROMPT:";

// Style prompt for the image, this is appended to all image prompts
const imageStyle = ", black and white only, no color, monochrome, in the style of an adventure game from the 1980s as pixel art, there must be no watermarks, logos, or text in the image."

const createImages = true;     //default: true
const numMaxTokens = 600;        //default: 1000
const temperature = .7;         //default: 0.7
/* End Prompts and Knobs */

/* Begin Routes */
app.post('/api/authenticate', (req, res) => {
    // Hardcoded credentials
    const username = process.env.USERNAME;
    const password = process.env.PASSWORD;

    if (req.body.username === username && req.body.password === password) {
        req.session.authenticated = true;
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

app.post('/api/initGame', async (req, res) => {
    try {
        const response = await initGame();
        res.send({ response });
    } catch (error) {
        console.error('Error initiatizing the game', error);
        res.status(500).send({ error: 'An error occurred while processing your request.' });
    }
});

app.post('/api/generateNextTurn', async (req, res) => {
    const gameKey = req.body.gameKey;
    const prompt = req.body.prompt;

    try {
        const response = await generateNextTurn(gameKey, prompt);
        res.type('application/json');
        res.send({ response });
    } catch (error) {
        console.error('Error communicating with OpenAI API:', error);
        res.status(500).send({ error: 'An error occurred while processing your request.' });
    }
});

app.post('/api/generateImage', async (req, res) => {
    const prompt = req.body.prompt;

    if(createImages) {
        try {
            const imagePayload = await generateImage(prompt);
            res.type('image/png');
            res.set('X-Image-Alt-Text', sanitizeToASCII(imagePayload.imageAltText));
            res.send(imagePayload.image);
        } catch (error) {
            console.error('Error generating image:', error);
            res.status(500).send({ error: 'An error occurred while generating the image.' });
        }
    }
});
/* End Routes */

async function initGame() {
    let response = generateNextTurn();  // If no gameKey or command are sent, create a new game
    return response;
}

async function generateNextTurn(gameKey, prompt) {
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };

    let gameTurnHistory = [];

    if(gameKey == null) {
        // If no gameKey is sent, create a new game
        gameTurnHistory.push({"role": "system", "content": systemRulesPrompt})   // Now add in the system prompt
        gameTurnHistory.push({"role": "user", "content": gameScenarioPrompt})       // Send the game scenario creation prompt
    } else {
        gameTurnHistory = await getGameProgress(gameKey);  // Get the history of game turns to date. We need to send the complete history to the API to maintain state
        prompt = sanitize(prompt); // Do a quick (and crude) check to make sure there are no security issues in the prompt
        let formattedPrompt = {"role": "user", "content": prompt} // Format the command so we can send to the model API
        formattedPrompt.content + '. ' + createImagePrompt;     // Append the "createImagePrompt" prompt, so we can have nice fancy images
        gameTurnHistory.push({"role": "system", "content": systemRulesPrompt})   // Now add in the system prompt
        gameTurnHistory.push(formattedPrompt); // Finally add the new command
    }

    const textRequestBody = JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: gameTurnHistory,
        max_tokens: numMaxTokens,
        n: 1,
        stop: null,
        temperature: temperature,
    });

    const textResponse = await fetch(textAPIURL, {
        method: 'POST',
        headers: headers,
        body: textRequestBody,
    });

    const textData = await textResponse.json();

    if (!textData.choices || textData.choices.length === 0) {
        console.error('Unexpected API response:', textData);
        throw new Error('Invalid response from OpenAI API');
    }

    // If there was no gameKey, make one as it's a new game
    if(gameKey == null) {
        // The gameKey is based on the first 50 characters of the rendered game scenario
        gameKey = generateGameKey(textData.choices[0].message.content.substring(0, 50));
    }

    // Split the text response so we can get the image prompt out
    const substrs = textData.choices[0].message.content.split('IMAGE_PROMPT');
    let response = {};
    response.gameKey = gameKey;  // Return the key back to the client, every time. It will need it to maintain state.
    response.text = substrs[0];
    response.imagePrompt = substrs[1];

    // update the game state file. Remove the system prompt and add the most recent assistant response
    gameTurnHistory.splice(gameTurnHistory.length - 2, 1);
    gameTurnHistory.push({"role": "assistant", "content": textData.choices[0].message.content});
    saveGameProgress(gameKey, gameTurnHistory);

    return response;
}

async function generateImage(prompt) {
    if (createImages == true && prompt != null) {
        
        // Clean up the prompt in a lazy way (I will fix this eventually)
        prompt = prompt.slice(0, -1) + imageStyle;
        prompt = prompt.substring(2);
        prompt = sanitize(prompt);  // Do a quick (and crude) check to make sure there are no security issues in the prompt

        console.log("IMAGE PROMPT: " + prompt);

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        };

        const imageRequestBody = JSON.stringify({
            model: 'image-alpha-001',
            prompt: prompt,
            num_images: 1,
            size: '256x256',
            response_format: 'url',
        });

        const imageResponse = await fetch(imageAPIURL, {
            method: 'POST',
            headers: headers,
            body: imageRequestBody,
        });

        const imageData = await imageResponse.json();

        if (!imageData.data || imageData.data.length === 0) {
            console.error('Unexpected API response:', data.image);
            throw new Error('Invalid response from DALL-E API');
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
    const hash = crypto.createHash('sha256');
    hash.update(gameScenario);
    const gameKey = hash.digest('hex');
    
    return gameKey;
}

async function saveGameProgress(gameKey, gameHistory) {
    // These files are important - they maintain the state for each game session
    // (plus they are useful for debugging)
    const saveFileName = gameKey + '.log';
    const saveFilePath = 'gameStates/' + saveFileName;

    try {
      // Check if the file exists
      await fs.access(saveFilePath);
  
    } catch (error) {
      // If the file doesn't exist, create it
      if (error.code === 'ENOENT') {
        await fs.writeFile(saveFilePath, '');
      } else {
        // If there is an error other than 'ENOENT', re-throw the error
        throw error;
      }
    }
  
    // Update the file with any new rows
    const startIndex = Math.max(0, gameHistory.length - 2)
    for(let i=startIndex; i < gameHistory.length; i++) {
        await fs.appendFile(saveFilePath, JSON.stringify(gameHistory[i]) + '\n');
    }
  }

async function getGameProgress(gameKey) {
    const saveFileName = gameKey + '.log';
    const saveFilePath = 'gameStates/' + saveFileName;

    try {
        // Check if the file exists
        const gameTurnHistory = [];
        const fileData = await fs.readFile(saveFilePath, 'utf8');
        const lines = fileData.split('\n');
        for (const line of lines) {
            if (line.trim() !== '') {
              const jsonObject = JSON.parse(line);
              gameTurnHistory.push(jsonObject);
            }
          }

        return gameTurnHistory;
    
      } catch (error) {
        throw error;
      }
}

// Load gamePrompt from file
async function loadPromptFromFile(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf8');
    return content;
    } catch (error) {
        throw error;
    }
}

function isAuthenticated(req, res, next) {
  if (req.session.authenticated) {
    next();
  } else {
    res.redirect('/');
  }
}

function sanitizeToASCII(str) {
    return str.replace(/[^\x00-\x7F]/g, '');
}

function sanitize(str) {
    // Remove potential HTML elements
    str = str.replace(/<[^>]*>/g, '');
  
    // Remove potential ECMAScript method calls
    str = str.replace(/\./g, '');
  
    // Remove single quotes
    str = str.replace(/'/g, '');
  
    return str;
  }

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
