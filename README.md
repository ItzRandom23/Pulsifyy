# Pulsifyy

> **Use YouTube and YouTube Music at your own risk.** In 2021, YouTube sent cease-and-desist notices to the operators of the original Groovy and Rythm Discord music bots. Both bots shut down. Review YouTube's terms and only use content you have permission to play. [YouTube Terms of Service](https://www.youtube.com/t/terms) · [Groovy coverage](https://www.theverge.com/2021/8/24/22640024/youtube-discord-groovy-music-bot-closure) · [Rythm coverage](https://www.theverge.com/2021/9/12/22669502/youtube-discord-rythm-music-bot-closure)

Pulsifyy is a Lavalink v4 client for Discord music bots. It handles voice connections, queues, playback controls, audio filters, autoplay, and node recovery.

[Read the documentation](https://pulsifyy.vercel.app/)

## Supported sources

| Feature | Sources |
| --- | --- |
| Search | Apple Music, Audiomack, Bandcamp, Deezer, Gaana, JioSaavn, SoundCloud, Spotify, Tidal, VK Music, YouTube, and YouTube Music |
| Autoplay | Deezer, JioSaavn, SoundCloud, Spotify, Tidal, and VK Music. Last.fm is an optional recommendation fallback with an API key. |
| Direct links | HTTP(S) links your Lavalink server can load |

Install PulseLink on your Lavalink server to use its Apple Music, Audiomack, Deezer, Gaana, JioSaavn, SoundCloud, Spotify, Tidal, and VK Music providers. Enable the providers you want and configure their credentials or playback mirrors where required. Deezer is Pulsifyy's default text search source. [PulseLink setup and provider requirements](https://github.com/ItzRandom23/PulseLink#quick-start)

Lavalink includes built-in Bandcamp and SoundCloud sources. Enable `bandcamp` for Bandcamp or `soundcloud` and `soundcloudSearchEnabled` for standalone SoundCloud search. Choose one SoundCloud source per node when configuring PulseLink. [Lavalink source configuration](https://lavalink.dev/configuration/config/file)

For YouTube and YouTube Music search, install and enable the Lavalink `youtube-source` plugin and allow search. Include its `MUSIC` client for YouTube Music search. [Lavalink YouTube plugin setup](https://github.com/lavalink-devs/youtube-source#plugin)

## Install

Use Node.js 22.19 or newer and Lavalink v4. Pulsifyy works with a Discord client that can send gateway packets and forward voice events.

Install Pulsifyy from npm.

```sh
npm install pulsifyy
```

The optional starter bot uses discord.js 14. If you follow that example, also run `npm install discord.js@14`. Pulsifyy’s declarations reference discord.js types. TypeScript projects that check library declarations can use `npm install -D discord.js@14` to resolve those types when using another Discord client.

For local testing, run `npm pack` in the Pulsifyy repo and install the resulting `pulsifyy-0.1.2.tgz` from your bot project.

## Use Pulsifyy

Create a `Manager` with your Lavalink nodes and a `send` callback that forwards voice packets to the Discord shard for each guild. Read Lavalink passwords from your application's configuration. Forward Discord raw voice events to `manager.updateVoiceState(packet)`, call `manager.init(client.user.id)` once Discord is ready, and wait for `nodeConnect` before searching.

```js
const { SearchPlatform } = require("pulsifyy");

// Run these after Lavalink is ready.
const videos = await manager.search("song name", requester, SearchPlatform.YouTube);
const music = await manager.search("song name", requester, SearchPlatform.YouTubeMusic);
```

Your bot needs the Guilds and Guild Voice States intents. Call `await manager.handleShutdown()` when your bot shuts down. [Set up and run the starter bot](docs/getting-started.md)

- [Player controls, configuration, and events](docs/usage.md)
- [Troubleshooting](docs/troubleshooting.md)

Pulsifyy is derived from Magmastream and maintained by ItzRandom23. Credit goes to the original Magmastream team. The [Apache-2.0 license](LICENSE) applies.
