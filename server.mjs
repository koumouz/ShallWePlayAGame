import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import FormData from 'form-data';
import { fileURLToPath } from 'url';
import basicAuth from 'basic-auth';

const app = express();
const port = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, '.')));
app.use(express.json({ limit: '50mb' }));


/* Core Promts and Knobs*/

// Game Rules
let gamePrompt = "You are an interface for a text-based interactive fiction video game in the style of Zork, Planetfall and Wishbringer. You are responsible for creating the narrative direction of the game. Each turn you will give the player a description of the current location they are in, which direction they can move to next and the effect of their actions on the world. On the player’s turn, they will give you a prompt for what they want to do next, where they want to go and what actions they want to take. You will always allow the player to make decisions around the player character and will never act on their behalf. All decisions from the player are based on their prompts; you should never assume the player does anything. The player is always referred to in the 2nd person (“You are here. You walked down the street, etc.). The game will last 50 turns and you will try to see the narrative reach a conclusion within the 50 turn limit. The player can make decisions that would cause their character to die, like walking off a cliff or fighting a monster. If they do so, it is game over and experience ends. You will strive to keep your descriptions as concise and short as possible. Include relevant detail that the player should know about the scene, but do not be overly verbose. Try to keep the total number of words and sentences you use as short as possible. After teach turn, ask the player “What would you like to do next?”Player actions are limited to basic movement, talking to characters or interacting with the environment. The player cannot break character and ask you about unrelated topics that are unrelated to the game. If the player asks any questions that are not related to the game descriptions you have given them, prompt the player to focus on the game at hand and refuse to answer other questions. It should be possible for the player to die and then the game is over. Create obstacles and dangers for the player to face and if they fail to meet the challenge (like fighting a monster that is more power than them) or if they do something reckless (like walking off a cliff) then the player’s game is over. Once a game over happens, you should refuse to answer any more prompts from the player and instead ask them if they want to start a new game. It’s important that the player feels there is some risk involved - it should be difficult for them to progress through the game and rewarding when they complete puzzles and challenges that you place in their path.Any characters that you create within the game scenario that are not the player character, you are free to control and determine how they should act. However, the player character is always the main character of the story.";

// Game Setting
gamePrompt += "The setting of this game is in the late 1970s. You are a high school kid who decided to go camping on a remote island off the coast of their small New England town on a dare from your friends. There are rumors of weird supernatural events on this island, perhaps something to do with secret military experiments that were possible run on the island during World War 2. They say the military was researching the occult, to gain some way to defeat the Nazis. They say no one has been able to stay the night on the island alone, but the player is eager to try. The story begins as the player rows their boat to the island, dock it at the beach and then look on at the mysterious, foggy island wondering what to do next. Unfortunately their boat is damaged when they arrive and now they can no longer leave the island with it. They will need to find another way.";

// Prompt to tell the model to also generate an image prompt
const createImagePrompt = "Additionally, create a prompt for stable diffusion to create an image that maps to the scene. This should always be the last sentence of your response and it should beging with IMAGE_PROMPT: and then the prompt.";

// Default image prompt, this is not current used
let imagePrompt = "A mysterious island at twilight surrounded by fog."

// Style prompt for the image, this is appended to all image prompts
const imageStyle = ", black and white only, in the style of an adventure game from the 1980s as pixel art"

const createImages = true;
const numMaxTokens = 300;
/* End Prompts and Knobs */


// Authentication middleware
const authMiddleware = (req, res, next) => {
    const user = basicAuth(req);
    const username = 'bueller';
    const password = 'I like playing games';

    if (user && user.name === username && user.pass === password) {
        next();
    } else {
        res.set('WWW-Authenticate', 'Basic realm="Authorization Required"');
        res.status(401).send('Authorization Required');
    }
};

// Apply authentication middleware to all routes
//app.use(authMiddleware);

/* Begin Routes */
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
        const imageURL = await generateImage(prompt);
        const imageResponse = await fetch(imageURL);
        const imageBuffer = await imageResponse.buffer();

        res.type('image/png');
        res.send(imageBuffer);
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
    const apiKey = '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';
    const textURL = 'https://api.openai.com/v1/chat/completions';
    const imageURL = 'https://api.openai.com/v1/images/generations';
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };

    // Update the most recent prompt to append the "createImagePrompt" prompt, so we can have nice fancy images
    history[history.length - 1].content = history[history.length - 1].content.split('.')[0] + createImagePrompt;

    // Generate the text
    const textRequestBody = JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: history,
        max_tokens: numMaxTokens,
        n: 1,
        stop: null,
        temperature: 0.3,
    });

    const textResponse = await fetch(textURL, {
        method: 'POST',
        headers: headers,
        body: textRequestBody,
    });

    const textData = await textResponse.json();

    if (!textData.choices || textData.choices.length === 0) {
        console.error('Unexpected API response:', textData);
        throw new Error('Invalid response from OpenAI API');
    }

    // Split the text response so we can get the image prompt from it
    const substrs = textData.choices[0].message.content.split('IMAGE_PROMPT');
    imagePrompt = substrs[1];

    let payload = {};
    payload.text = substrs[0].trim();

    if(createImages == true && imagePrompt != null) {
        // Now generate the image
        imagePrompt = imagePrompt + imageStyle;
        const imageRequestBody = JSON.stringify({
            model: 'image-alpha-001',
            prompt: imagePrompt,
            num_images: 1,
            size: '256x256',
            response_format: 'url',
        });

        const imageResponse = await fetch(imageURL, {
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

        payload.image = Buffer.from(imageBuffer);
        payload.imageAltText = imagePrompt;
    }
    
    // DEBUG: Show the prompts and responses
    //console.log("\nResponse: " + textData.choices[0].message.content);
    //console.log("\nText Response: " + payload.text);
    //console.log("\nImage Prompt: " + imagePrompt + imageStyle);

    return payload;
}

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
