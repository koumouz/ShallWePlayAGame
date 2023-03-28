import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import FormData from 'form-data';
import session from 'express-session';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = 3000;

app.use(express.json({ limit: '50mb' }));

app.use(
  session({
    secret: 'h47u3jnkf034jtldfg-0345jmsd0-m902378',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }, // Change to `true` if using HTTPS
  })
);

// Middleware to protect game.html
app.use('/game.html', (req, res, next) => {
  if (req.session.authenticated) {
    next();
  } else {
    res.redirect('/');
  }
});

app.use(express.static(__dirname + '/public')); // Serve files from the public folder

/* Core Prompts and Knobs*/

/* OpenAI API */
const apiKey = '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';
const textAPIURL = 'https://api.openai.com/v1/chat/completions';
const imageAPIURL = 'https://api.openai.com/v1/images/generations';
/* End OpenAI API */

// Game Rules
let gamePrompt = await loadGamePrompt('gamePrompts/adventure1.txt');

// Prompt to tell the model to also generate an image prompt
const createImagePrompt = "Additionally, create a prompt for stable diffusion to create an image that maps to the scene. This should always be the last sentence of your response and it should beging with IMAGE_PROMPT: and then the prompt.";

// Style prompt for the image, this is appended to all image prompts
const imageStyle = ", black and white only, in the style of an adventure game from the 1980s as pixel art"

const createImages = true;
const numMaxTokens = 300;
const temperature = 1;
/* End Prompts and Knobs */

/* Begin Routes */
app.post('/api/authenticate', (req, res) => {
    // Hardcoded credentials
    const username = 'user';
    const password = '123';

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
    const turnHistory = req.body.turnHistory;

    try {
        const response = await generateNextTurn(turnHistory);
        res.type('application/json');
        res.send({ response });
    } catch (error) {
        console.error('Error communicating with OpenAI API:', error);
        res.status(500).send({ error: 'An error occurred while processing your request.' });
    }
});

app.post('/api/generateImage', async (req, res) => {
    const prompt = req.body.prompt;

    try {
        const imagePayload = await generateImage(prompt);
        res.type('image/png');
        res.set('X-Image-Alt-Text', imagePayload.imageAltText);
        res.send(imagePayload.image);
    } catch (error) {
        console.error('Error generating image:', error);
        res.status(500).send({ error: 'An error occurred while generating the image.' });
    }
});

/* End Routes */

async function initGame() {
    let initHistory = [];
    initHistory.push({"role": "assistant", "content": gamePrompt});

    return generateNextTurn(initHistory);
}

async function generateNextTurn(history) {
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };

    // Update the most recent prompt to append the "createImagePrompt" prompt, so we can have nice fancy images
    history[history.length - 1].content = history[history.length - 1].content + createImagePrompt;

    // Generate the text
    const textRequestBody = JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: history,
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

    // Split the text response so we can get the image prompt out
    const substrs = textData.choices[0].message.content.split('IMAGE_PROMPT');
    let payload = {};
    payload.text = substrs[0];
    payload.imagePrompt = substrs[1];

    // DEBUG: Show the prompts and responses
    //console.log("\nPrompt: " + history[history.length - 1].content);
    //console.log("\nText Response: " + payload.text);

    return payload;
}

async function generateImage(prompt) {
    if (createImages == true && prompt != null) {
        // Now generate the image
        prompt = prompt + imageStyle;

        // DEBUG
        //console.log("\nGenerate Image: " + prompt);

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

// Load gamePrompt from file
async function loadGamePrompt(path) {
  try {
    const content = await fs.readFile(path, 'utf8');
    return content;
  } catch (err) {
    console.error('Error reading ' + path, err);
    throw new Error('Failed to load gamePrompt from file');
  }
}

function isAuthenticated(req, res, next) {
  if (req.session.authenticated) {
    next();
  } else {
    res.redirect('/');
  }
}

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
