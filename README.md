# Shall We Play a Game?

"Shall We Play a Game??" is a prototype in generative interactive fiction
using <a href="https://en.wikipedia.org/wiki/Large_language_model" target="_blank">large language models</a>
and <a href="https://en.wikipedia.org/wiki/Diffusion_model" target="_blank">image diffusion models</a>. All the
content the player interacts with is generated in real time, creating a unique playthrough on each session.

This allows for much greater player agency as players are no longer confined to the crude text parsers of the 80s and instead can really explore
their surrounding with rich text commands. The narrative can take many turns as the LLM determines where to go based on the player input, while
ensuring some structure based on initial game prompts (to set a base scenerio and outline for the game). The goal is take turn hallucination into a
feature, not a bug. With that said - every once in a while you may seem some pretty strange behaviors!

The interface and gameplay was inspired by the interactive fiction games of the 1980s, which
I grew up playing (the first computer monitors I used were <a href="https://en.wikipedia.org/wiki/Monochrome_monitor" target="_blank">
amber CRTs</a> :)

Every playthrough is unique! Check it out at https://www.shallweplayagame.ai

## Development Notes

- Game state is now persisted in Postgres. Configure the `DATABASE_URL` environment variable (or rely on local Postgres defaults) before starting the server. Set `DATABASE_SSL=true` when connecting to managed providers (e.g. Heroku) from local development. A `game_sessions` table will be created automatically if it does not exist.
- Image generation defaults to DALL·E 3 (`IMAGE_MODEL=dall-e-3`). Adjust the model, size, or quality with `IMAGE_MODEL`, `IMAGE_SIZE`, or `IMAGE_QUALITY` environment variables if you need different outputs or performance profiles.
- Install dependencies with `npm install` (this adds the `pg` driver) and run the server with `npm start` or `npm run dev`.
