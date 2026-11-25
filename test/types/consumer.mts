import { Manager, ManagerEventTypes, SearchPlatform, TrackPartial, type VoicePacket } from "pulsifyy";
import pulsify from "pulsifyy";

const manager = new Manager({
  nodes: [{ host: "localhost", password: "fixture" }],
  send(guildId, payload) { void [guildId, payload.d.channel_id]; },
  trackPartial: [TrackPartial.Track],
});
manager.on(ManagerEventTypes.TrackStart, (player, track) => { void [player.guildId, track.track]; });
const packet: VoicePacket = { t: "VOICE_SERVER_UPDATE", d: { token: "fixture", guild_id: "42", endpoint: null } };
void manager.updateVoiceState(packet);
const player = manager.create({ guildId: "42" });
void player.search({ query: "song", source: SearchPlatform.SoundCloud }, undefined, ["soundcloud"]);
void player.search("song", undefined, [SearchPlatform.YouTube, SearchPlatform.YouTubeMusic]);
void player.play({ startTime: 12, noReplace: true });
void manager.loadPlaylistInChunks(player, "playlist");
void pulsify.TrackUtils.validate({ track: "encoded" });
