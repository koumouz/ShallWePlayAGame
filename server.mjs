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
let gamePrompt = "You are an interface for a text-based video game in the style of Zork, Planetfall and Wishbringer. You are responsible for creating the narrative direction of the game. Each turn, you will give me, the player, a describing the current location of the player and the effect of their actions on the world. On my turn I will tell you where I want to go and what actions I want to take. The setting is in the late 1970s. 5 highschool kids around the ages of 16 decided to camp on a remote island off the coast of their small New England town. There are rumors of weird supernatural events on this island, perhaps something to do with secret military experiments that were possible run on the island during World War 2. They say the military was researching the occult, to gain some way to defeat the Nazis. You will take this basic premise and then expand on the story, adding new scenarios and introducing new twists and turns in the narrative. I will play one of the five kids, my name will be Rupert. You will play the other 4 characters and will give them each a name and backstory.";
gamePrompt += "The story begins as we all step foot off the rowboat we used to reach the island. It’s twilight and we are excited to begin our adventure. Begin the first turn with a short introduction of all the characters, including me and explain the setting.";
gamePrompt += "Only I can take actions for the player, you can never act as the player character. The player can continue taking turns up to a maximum of 10 turns. After that you should respond with a message that the game is now over and then create a satisfying ending to the story for the player."

let createImagePrompt = "Additionally, create a prompt for stable diffusion to create an image that maps to the scene. This should always be the last sentence of your response and it should beging with IMAGE_PROMPT: and then the prompt";

let imagePrompt = "A mysterious island at twilight surrounded by fog."
let imageStyle = ", black and white only, in the style of an adventure game from the 1980s, pixel art, high quality"

let createImages = false;
let numMaxTokens = 350;
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
    history[history.length - 1].content += createImagePrompt;

    // Generate the text
    const textRequestBody = JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: history,
        max_tokens: numMaxTokens,
        n: 1,
        stop: null,
        temperature: 0.5,
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
    }
    
    // DEBUG: Show the prompts and responses
    //console.log("\nResponse: " + textData.choices[0].message.content);
    //console.log("\nText Response: " + payload.text);
    console.log("\nImage Prompt: " + imagePrompt + imageStyle);

    return payload;
}

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
