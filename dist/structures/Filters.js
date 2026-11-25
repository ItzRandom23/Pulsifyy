"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AvailableFilters = exports.Filters = void 0;
const filtersEqualizers_1 = require("../utils/filtersEqualizers");
const Manager_1 = require("./Manager");
const defaultFilterValues = {
    distortion: null,
    equalizer: [],
    karaoke: null,
    rotation: null,
    timescale: null,
    vibrato: null,
    tremoloOptions: null,
    channelMix: null,
    lowPass: null,
    reverb: null,
    volume: 1.0,
    bassBoostlevel: 0,
};
const boostedVolume = 200;

class Filters {
    distortion;
    equalizer;
    karaoke;
    player;
    rotation;
    timescale;
    vibrato;
    tremoloOptions;
    channelMix;
    lowPass;
    reverb;
    volume;
    bassBoostlevel;
    filtersStatus;
    #volumeBeforeEarrape = null;
    constructor(player) {
        this.player = player;
        Object.assign(this, structuredClone(defaultFilterValues));
        this.filtersStatus = Object.fromEntries(Object.values(AvailableFilters).map(filter => [filter, false]));
    }
    #filterSettings(values = this) {
        const { distortion, equalizer, karaoke, rotation, timescale, vibrato, tremoloOptions, channelMix, lowPass, volume } = values;
        return { distortion, equalizer, karaoke, rotation, timescale, vibrato, tremoloOptions, channelMix, lowPass, volume };
    }

    payload(values = this) {
        // Lavalink replaces the filter chain and rejects any disabled filter sent in the payload.
        const { equalizer, volume, tremoloOptions, ...effects } = this.#filterSettings(values);
        const filters = Object.fromEntries(Object.entries({ ...effects, tremolo: tremoloOptions })
            .filter(([, value]) => value != null));
        if (equalizer?.some(band => band?.gain !== 0)) filters.equalizer = equalizer;
        if (volume != null && volume !== defaultFilterValues.volume) filters.volume = volume;
        return filters;
    }

    snapshot() {
        return structuredClone({
            ...this.#filterSettings(), bassBoostlevel: this.bassBoostlevel,
            filterStatus: this.filtersStatus, volumeBeforeEarrape: this.#volumeBeforeEarrape,
        });
    }

    restore(snapshot) {
        for (const key of Object.keys(defaultFilterValues)) {
            if (key !== "reverb" && Object.hasOwn(snapshot, key)) this[key] = structuredClone(snapshot[key]);
        }
        for (const key of Object.values(AvailableFilters)) {
            if (typeof snapshot.filterStatus?.[key] === "boolean") this.filtersStatus[key] = snapshot.filterStatus[key];
        }
        // Older snapshots could give multiple presets ownership of one field.
        const active = Object.entries(effectProperties).filter(([effect]) => this.filtersStatus[effect]);
        for (const [effect, fields] of active) {
            if (active.some(([other, otherFields]) => other !== effect && fields.some(field => otherFields.includes(field)))) {
                this.filtersStatus[effect] = false;
            }
        }
        this.reverb = null;
        this.filtersStatus[AvailableFilters.SetReverb] = false;
        const previousVolume = snapshot.volumeBeforeEarrape;
        this.#volumeBeforeEarrape = Number.isInteger(previousVolume) && previousVolume >= 0 && previousVolume <= 1000
            ? previousVolume : null;
    }

    async updateFilters() {
        await this.player.runOperation(() => this.player.node.rest.updatePlayer({
            data: { filters: structuredClone(this.payload()) }, guildId: this.player.guildId,
        }));
        return this;
    }
    /**
     * Applies a specific filter to the player.
     *
     * This method allows you to set the value of a specific filter property.
     * The filter property must be a valid key of the Filters object.
     *
     * @param {{ property: T; value: Filters[T] }} filter - An object containing the filter property and value.
     * @param {boolean} [updateFilters=true] - Whether to update the filters after applying the filter.
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async applyFilter(filter, updateFilters = true) {
        return this.applyFilters({ [filter.property]: filter.value }, updateFilters);
    }
    async applyFilters(filters, updateFilters = true) {
        for (const key of Object.keys(filters)) {
            if (!Object.hasOwn(defaultFilterValues, key)) throw new TypeError("Unknown audio filter property.");
        }
        if (filters.reverb != null) throw new RangeError("Reverb is not a built-in Lavalink v4 filter.");
        return this.#updateFields(structuredClone(filters), { sendFilters: updateFilters });
    }

    #updateFields(requested, { flag, enabled, requireActive = false, sendFilters = true } = {}) {
        return this.player.runOperation(async () => {
            const statuses = { ...this.filtersStatus };
            if (requireActive && !statuses[flag]) return this;

            const changes = {};
            for (const [effect, fields] of Object.entries(effectProperties)) {
                if (effect === flag || !statuses[effect] || !fields.some(field => Object.hasOwn(requested, field))) continue;
                statuses[effect] = false;
                for (const field of fields) changes[field] = defaultFilterValues[field];
            }
            Object.assign(changes, requested);
            if (flag) statuses[flag] = enabled;
            return this.#commit(changes, statuses, { sendFilters });
        });
    }

    #setFilter(flag, field, value) {
        return this.#updateFields({ [field]: structuredClone(value) }, { flag, enabled: value !== null });
    }

    #togglePreset(flag, status, settings) {
        const enabled = Boolean(status);
        const changes = enabled ? settings : Object.fromEntries(
            Object.keys(settings).map(field => [field, defaultFilterValues[field]]),
        );
        return this.#updateFields(changes, { flag, enabled, requireActive: !enabled });
    }

    async #commit(changes, statuses, { sendFilters = true, volume, volumeBeforeEarrape = this.#volumeBeforeEarrape } = {}) {
        const committed = structuredClone(changes);
        const data = {};
        if (sendFilters) data.filters = structuredClone(this.payload({ ...this, ...committed }));
        if (volume !== undefined) data.volume = volume;
        const oldPlayer = volume === undefined ? null : { ...this.player };
        if (sendFilters || volume !== undefined) {
            await this.player.node.rest.updatePlayer({ guildId: this.player.guildId, data });
        }
        Object.assign(this, committed);
        Object.assign(this.filtersStatus, statuses);
        this.#volumeBeforeEarrape = volumeBeforeEarrape;
        if (oldPlayer) {
            this.player.volume = volume;
            this.player.manager.emit(Manager_1.ManagerEventTypes.PlayerStateUpdate, oldPlayer, this.player, {
                changeType: Manager_1.PlayerStateEventTypes.VolumeChange,
                details: { previousVolume: oldPlayer.volume, currentVolume: volume },
            });
        }
        return this;
    }

    #restorePlayerVolume() {
        if (this.filtersStatus[AvailableFilters.Earrape] && this.player.volume === boostedVolume) {
            return this.#volumeBeforeEarrape ?? 100;
        }
        return undefined;
    }
    /**
     * Sets the status of a specific filter.
     *
     * This method updates the filter status to either true or false, indicating whether
     * the filter is applied or not. This helps track which filters are active.
     *
     * @param {AvailableFilters} filter - The filter to update.
     * @param {boolean} status - The status to set (true for active, false for inactive).
     * @returns {this} - Returns the current instance of the Filters class for method chaining.
     */
    setFilterStatus(filter, status) {
        if (!Object.hasOwn(this.filtersStatus, filter) || typeof status !== "boolean") throw new TypeError("Invalid audio filter status.");
        this.filtersStatus[filter] = status;
        return this;
    }
    /**
     * Retrieves the status of a specific filter.
     *
     * This method returns whether a specific filter is currently applied or not.
     *
     * @param {AvailableFilters} filter - The filter to check.
     * @returns {boolean} - Returns true if the filter is active, false otherwise.
     */
    getFilterStatus(filter) {
        return this.filtersStatus[filter];
    }
    /**
     * Clears all filters applied to the audio.
     *
     * This method resets all filter settings to their default values and removes any
     * active filters from the player.
     *
     * @returns {this} - Returns the current instance of the Filters class for method chaining.
     */
    async clearFilters() {
        return this.player.runOperation(() => this.#commit(
            defaultFilterValues,
            Object.fromEntries(Object.values(AvailableFilters).map(filter => [filter, false])),
            { volume: this.#restorePlayerVolume(), volumeBeforeEarrape: null },
        ));
    }
    /**
     * Sets the own equalizer bands on the audio.
     *
     * This method adjusts the equalization curve of the player's audio output,
     * allowing you to control the frequency response.
     *
     * @param {Band[]} [bands] - The equalizer bands to apply (band, gain).
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async setEqualizer(bands) {
        return this.applyFilter({ property: "equalizer", value: bands ?? [] });
    }
    /**
     * Sets the own karaoke options to the audio.
     *
     * This method adjusts the audio so that it sounds like a karaoke song, with the
     * original vocals removed. Note that not all songs can be successfully made into
     * karaoke tracks, and some tracks may not sound as good.
     *
     * @param {karaokeOptions} [karaoke] - The karaoke settings to apply (level, monoLevel, filterBand, filterWidth).
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async setKaraoke(karaoke) {
        return this.#setFilter(AvailableFilters.SetKaraoke, "karaoke", karaoke ?? null);
    }
    /**
     * Sets the own timescale options to the audio.
     *
     * This method adjusts the speed and pitch of the audio, allowing you to control the playback speed.
     *
     * @param {timescaleOptions} [timescale] - The timescale settings to apply (speed and pitch).
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async setTimescale(timescale) {
        return this.#setFilter(AvailableFilters.SetTimescale, "timescale", timescale ?? null);
    }
    /**
     * Sets the own vibrato options to the audio.
     *
     * This method applies a vibrato effect to the audio, which adds a wavering,
     * pulsing quality to the sound. The effect is created by rapidly varying the
     * pitch of the audio.
     *
     * @param {vibratoOptions} [vibrato] - The vibrato settings to apply (frequency, depth).
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async setVibrato(vibrato) {
        return this.#setFilter(AvailableFilters.Vibrato, "vibrato", vibrato ?? null);
    }
    async setTremolo(tremolo) {
        return this.#setFilter(AvailableFilters.SetTremolo, "tremoloOptions", tremolo ?? null);
    }
    async setChannelMix(channelMix) {
        return this.#setFilter(AvailableFilters.SetChannelMix, "channelMix", channelMix ?? null);
    }
    async setLowPass(lowPass) {
        return this.#setFilter(AvailableFilters.SetLowPass, "lowPass", lowPass ?? null);
    }
    async setReverb(reverb) {
        if (reverb != null) throw new RangeError("Reverb is not a built-in Lavalink v4 filter.");
        return this.#updateFields({ reverb: null }, { flag: AvailableFilters.SetReverb, enabled: false, sendFilters: false });
    }
    /**
     * Sets the own rotation options effect to the audio.
     *
     * This method applies a rotation effect to the audio, which simulates the sound
     * moving around the listener's head. This effect can create a dynamic and immersive
     * audio experience by altering the directionality of the sound.
     *
     * @param {rotationOptions} [rotation] - The rotation settings to apply (rotationHz).
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async setRotation(rotation) {
        return this.#setFilter(AvailableFilters.SetRotation, "rotation", rotation ?? null);
    }
    /**
     * Sets the own distortion options effect to the audio.
     *
     * This method applies a distortion effect to the audio, which adds a rougher,
     * more intense quality to the sound. The effect is created by altering the
     * audio signal to create a more jagged, irregular waveform.
     *
     * @param {distortionOptions} [distortion] - The distortion settings to apply (sinOffset, sinScale, cosOffset, cosScale, tanOffset, tanScale, offset, scale).
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async setDistortion(distortion) {
        return this.#setFilter(AvailableFilters.SetDistortion, "distortion", distortion ?? null);
    }
    /**
     * Sets the bass boost level on the audio.
     *
     * This method scales the gain of a predefined equalizer curve to the specified level.
     * The curve is designed to emphasize or reduce low frequencies, creating a bass-heavy
     * or bass-reduced effect.
     *
     * @param {number} level - The level of bass boost to apply. The value ranges from -3 to 3,
     *                         where negative values reduce bass, 0 disables the effect,
     *                         and positive values increase bass.
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     *
     * @example
     * // Apply different levels of bass boost or reduction:
     * await player.bassBoost(3);  // Maximum Bass Boost
     * await player.bassBoost(2);  // Medium Bass Boost
     * await player.bassBoost(1);  // Mild Bass Boost
     * await player.bassBoost(0);  // No Effect (Disabled)
     * await player.bassBoost(-1); // Mild Bass Reduction
     * await player.bassBoost(-2); // Medium Bass Reduction
     * await player.bassBoost(-3); // Maximum Bass Removal
     */
    async bassBoost(stage) {
        if (typeof stage !== "number" || !Number.isFinite(stage)) throw new TypeError("Bass boost requires a finite level.");
        const level = Math.max(-3, Math.min(3, stage));
        const equalizer = filtersEqualizers_1.bassBoostEqualizer.map(band => ({ band: band.band, gain: band.gain * level / 3 }));
        return this.#togglePreset(AvailableFilters.BassBoost, level !== 0, { equalizer, bassBoostlevel: level });
    }
    /**
     * Toggles the chipmunk effect on the audio.
     *
     * This method applies or removes a chipmunk effect by adjusting the timescale settings.
     * When enabled, it increases the speed, pitch, and rate of the audio, resulting in a high-pitched, fast playback
     * similar to the sound of a chipmunk.
     *
     * @param {boolean} status - Whether to enable or disable the chipmunk effect.
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async chipmunk(status) {
        return this.#togglePreset(AvailableFilters.Chipmunk, status, { timescale: { speed: 1.08, pitch: 1.35, rate: 1.0 } });
    }
    /**
     * Toggles the "China" effect on the audio.
     *
     * This method applies or removes a filter that reduces the pitch of the audio by half,
     * without changing the speed or rate. This creates a "hollow" or "echoey" sound.
     *
     * @param {boolean} status - Whether to enable or disable the "China" effect.
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async china(status) {
        return this.#togglePreset(AvailableFilters.China, status, { timescale: { speed: 1.0, pitch: 0.82, rate: 1.0 } });
    }
    /**
     * Toggles the 8D audio effect on the audio.
     *
     * This method applies or removes an 8D audio effect by adjusting the rotation settings.
     * When enabled, it creates a sensation of the audio moving around the listener's head,
     * providing an immersive audio experience.
     *
     * @param {boolean} status - Whether to enable or disable the 8D effect.
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async eightD(status) {
        return this.#togglePreset(AvailableFilters.EightD, status, {
            rotation: { rotationHz: 0.18 },
            channelMix: { leftToLeft: 0.85, leftToRight: 0.15, rightToLeft: 0.15, rightToRight: 0.85 },
        });
    }
    /**
     * Toggles the nightcore effect on the audio.
     *
     * This method applies or removes a nightcore effect by adjusting the timescale settings.
     * When enabled, it increases the speed and pitch of the audio, giving it a more
     * upbeat and energetic feel.
     *
     * @param {boolean} status - Whether to enable or disable the nightcore effect.
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async nightcore(status) {
        return this.#togglePreset(AvailableFilters.Nightcore, status, { timescale: { speed: 1.12, pitch: 1.18, rate: 1.0 } });
    }
    /**
     * Toggles the slowmo effect on the audio.
     *
     * This method applies or removes a slowmo effect by adjusting the timescale settings.
     * When enabled, it slows down the audio while keeping the pitch the same, giving it
     * a more relaxed and calming feel.
     *
     * @param {boolean} status - Whether to enable or disable the slowmo effect.
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async slowmo(status) {
        return this.#togglePreset(AvailableFilters.Slowmo, status, { timescale: { speed: 0.78, pitch: 1.0, rate: 1.0 } });
    }
    /**
     * Toggles a soft equalizer effect to the audio.
     *
     * This method applies or removes a soft equalizer effect by adjusting the equalizer settings.
     * When enabled, it reduces the bass and treble frequencies, giving the audio a softer and more
     * mellow sound.
     *
     * @param {boolean} status - Whether to enable or disable the soft equalizer effect.
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async soft(status) {
        return this.#togglePreset(AvailableFilters.Soft, status, { equalizer: filtersEqualizers_1.softEqualizer });
    }
    /**
     * Toggles the TV equalizer effect on the audio.
     *
     * This method applies or removes a TV equalizer effect by adjusting the equalizer settings.
     * When enabled, it enhances specific frequency bands to mimic the audio characteristics
     * typically found in television audio outputs.
     *
     * @param {boolean} status - Whether to enable or disable the TV equalizer effect.
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async tv(status) {
        return this.#togglePreset(AvailableFilters.TV, status, { equalizer: filtersEqualizers_1.tvEqualizer });
    }
    /**
     * Toggles the treble/bass equalizer effect on the audio.
     *
     * This method applies or removes a treble/bass equalizer effect by adjusting the equalizer settings.
     * When enabled, it enhances the treble and bass frequencies, giving the audio a more balanced sound.
     *
     * @param {boolean} status - Whether to enable or disable the treble/bass equalizer effect.
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async trebleBass(status) {
        return this.#togglePreset(AvailableFilters.TrebleBass, status, { equalizer: filtersEqualizers_1.trebleBassEqualizer });
    }
    /**
     * Toggles the vaporwave effect on the audio.
     *
     * This method applies or removes a vaporwave effect by adjusting the equalizer settings.
     * When enabled, it gives the audio a dreamy and nostalgic feel, characteristic of the vaporwave genre.
     *
     * @param {boolean} status - Whether to enable or disable the vaporwave effect.
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async vaporwave(status) {
        return this.#togglePreset(AvailableFilters.Vaporwave, status, {
            equalizer: filtersEqualizers_1.vaporwaveEqualizer,
            timescale: { speed: 0.9, pitch: 0.85, rate: 1.0 },
            rotation: { rotationHz: 0.05 },
        });
    }
    /**
     * Toggles the distortion effect on the audio.
     *
     * This method applies or removes a distortion effect by adjusting the distortion settings.
     * When enabled, it adds a rougher, more intense quality to the sound by altering the
     * audio signal to create a more jagged, irregular waveform.
     *
     * @param {boolean} status - Whether to enable or disable the distortion effect.
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async distort(status) {
        return this.#togglePreset(AvailableFilters.Distort, status, {
            distortion: { sinOffset: 0, sinScale: 0.15, cosOffset: 0, cosScale: 0.12, tanOffset: 0, tanScale: 0.1, offset: 0, scale: 1.05 },
        });
    }
    /**
     * Toggles the party effect on the audio.
     *
     * This method applies or removes a party effect by adjusting the equalizer settings.
     * When enabled, it enhances the bass and treble frequencies, providing a more energetic and lively sound.
     *
     * @param {boolean} status - Whether to enable or disable the party effect.
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async pop(status) {
        return this.#togglePreset(AvailableFilters.Pop, status, { equalizer: filtersEqualizers_1.popEqualizer });
    }
    /**
     * Toggles a party effect on the audio.
     *
     * This method applies a party effect to audio.
     * @param {boolean} status - Whether to enable or disable the party effect.
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async party(status) {
        return this.#togglePreset(AvailableFilters.Party, status, { equalizer: filtersEqualizers_1.partyEqualizer });
    }
    /**
     * Toggles earrape effect on the audio.
     *
     * This method applies earrape effect to audio.
     * @param {boolean} status - Whether to enable or disable the earrape effect.
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async earrape(status) {
        const enabled = Boolean(status);
        return this.player.runOperation(() => {
            if (this.filtersStatus[AvailableFilters.Earrape] === enabled) return this;
            return this.#commit({}, { [AvailableFilters.Earrape]: enabled }, {
                sendFilters: false,
                volume: enabled ? boostedVolume : this.#restorePlayerVolume(),
                volumeBeforeEarrape: enabled ? this.player.volume : null,
            });
        });
    }
    /**
     * Toggles electronic effect on the audio.
     *
     * This method applies electronic effect to audio.
     * @param {boolean} status - Whether to enable or disable the electronic effect.
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async electronic(status) {
        return this.#togglePreset(AvailableFilters.Electronic, status, { equalizer: filtersEqualizers_1.electronicEqualizer });
    }
    /**
     * Toggles radio effect on the audio.
     *
     * This method applies radio effect to audio.
     * @param {boolean} status - Whether to enable or disable the radio effect.
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async radio(status) {
        return this.#togglePreset(AvailableFilters.Radio, status, { equalizer: filtersEqualizers_1.radioEqualizer });
    }
    /**
     * Toggles a tremolo effect on the audio.
     *
     * This method applies a tremolo effect to audio.
     * @param {boolean} status - Whether to enable or disable the tremolo effect.
     * @returns {this} - Returns the current instance of the Filters class for method chaining.
     */
    async tremolo(status) {
        return this.#togglePreset(AvailableFilters.Tremolo, status, { tremoloOptions: { frequency: 4, depth: 0.35 } });
    }
    /**
     * Toggless a darthvader effect on the audio.
     *
     * This method applies a darthvader effect to audio.
     * @param {boolean} status - Whether to enable or disable the darthvader effect.
     * @returns {this} - Returns the current instance of the Filters class for method chaining.
     */
    async darthvader(status) {
        return this.#togglePreset(AvailableFilters.Darthvader, status, {
            equalizer: filtersEqualizers_1.demonEqualizer,
            timescale: { speed: 0.92, pitch: 0.68, rate: 1.0 },
        });
    }
    /**
     * Toggles a daycore effect on the audio.
     *
     * This method applies a daycore effect to audio.
     * @param {boolean} status - Whether to enable or disable the daycore effect.
     * @returns {this} - Returns the current instance of the Filters class for method chaining.
     */
    async daycore(status) {
        return this.#togglePreset(AvailableFilters.Daycore, status, { timescale: { speed: 0.85, pitch: 0.82, rate: 1.0 } });
    }
    /**
     * Toggles a doubletime effect on the audio.
     *
     * This method applies a doubletime effect to audio.
     * @param {boolean} status - Whether to enable or disable the doubletime effect.
     * @returns {this} - Returns the current instance of the Filters class for method chaining
     */
    async doubletime(status) {
        return this.#togglePreset(AvailableFilters.Doubletime, status, { timescale: { speed: 1.5, pitch: 1.0, rate: 1.0 } });
    }
    /**
     * Toggles the demon effect on the audio.
     *
     * This method applies or removes a demon effect by adjusting the equalizer,
     * and timescale settings to produce a deeper sound.
     *
     * @param {boolean} status - Whether to enable or disable the demon effect.
     * @returns {Promise<this>} - Returns the current instance of the Filters class for method chaining.
     */
    async demon(status) {
        return this.#togglePreset(AvailableFilters.Demon, status, {
            equalizer: filtersEqualizers_1.demonEqualizer,
            timescale: { speed: 0.92, pitch: 0.72, rate: 1.0 },
        });
    }
}
exports.Filters = Filters;
var AvailableFilters;
(function (AvailableFilters) {
    AvailableFilters["BassBoost"] = "bassboost";
    AvailableFilters["Distort"] = "distort";
    AvailableFilters["SetDistortion"] = "setDistortion";
    AvailableFilters["EightD"] = "eightD";
    AvailableFilters["SetKaraoke"] = "setKaraoke";
    AvailableFilters["Nightcore"] = "nightcore";
    AvailableFilters["Slowmo"] = "slowmo";
    AvailableFilters["Soft"] = "soft";
    AvailableFilters["TrebleBass"] = "trebleBass";
    AvailableFilters["SetTimescale"] = "setTimescale";
    AvailableFilters["TV"] = "tv";
    AvailableFilters["Vibrato"] = "vibrato";
    AvailableFilters["SetTremolo"] = "setTremolo";
    AvailableFilters["SetChannelMix"] = "setChannelMix";
    AvailableFilters["SetLowPass"] = "setLowPass";
    AvailableFilters["SetReverb"] = "setReverb";
    AvailableFilters["Vaporwave"] = "vaporwave";
    AvailableFilters["Pop"] = "pop";
    AvailableFilters["Party"] = "party";
    AvailableFilters["Earrape"] = "earrape";
    AvailableFilters["Electronic"] = "electronic";
    AvailableFilters["Radio"] = "radio";
    AvailableFilters["SetRotation"] = "setRotation";
    AvailableFilters["Tremolo"] = "tremolo";
    AvailableFilters["China"] = "china";
    AvailableFilters["Chipmunk"] = "chipmunk";
    AvailableFilters["Darthvader"] = "darthvader";
    AvailableFilters["Daycore"] = "daycore";
    AvailableFilters["Doubletime"] = "doubletime";
    AvailableFilters["Demon"] = "demon";
})(AvailableFilters || (exports.AvailableFilters = AvailableFilters = {}));

// A Lavalink filter field can have one active preset at a time.
const effectProperties = {
    [AvailableFilters.BassBoost]: ["equalizer", "bassBoostlevel"],
    [AvailableFilters.Distort]: ["distortion"],
    [AvailableFilters.SetDistortion]: ["distortion"],
    [AvailableFilters.EightD]: ["rotation", "channelMix"],
    [AvailableFilters.SetKaraoke]: ["karaoke"],
    [AvailableFilters.Nightcore]: ["timescale"],
    [AvailableFilters.Slowmo]: ["timescale"],
    [AvailableFilters.Soft]: ["equalizer"],
    [AvailableFilters.TrebleBass]: ["equalizer"],
    [AvailableFilters.SetTimescale]: ["timescale"],
    [AvailableFilters.TV]: ["equalizer"],
    [AvailableFilters.Vibrato]: ["vibrato"],
    [AvailableFilters.SetTremolo]: ["tremoloOptions"],
    [AvailableFilters.SetChannelMix]: ["channelMix"],
    [AvailableFilters.SetLowPass]: ["lowPass"],
    [AvailableFilters.SetReverb]: ["reverb"],
    [AvailableFilters.Vaporwave]: ["equalizer", "timescale", "rotation"],
    [AvailableFilters.Pop]: ["equalizer"],
    [AvailableFilters.Party]: ["equalizer"],
    [AvailableFilters.Electronic]: ["equalizer"],
    [AvailableFilters.Radio]: ["equalizer"],
    [AvailableFilters.SetRotation]: ["rotation"],
    [AvailableFilters.Tremolo]: ["tremoloOptions"],
    [AvailableFilters.China]: ["timescale"],
    [AvailableFilters.Chipmunk]: ["timescale"],
    [AvailableFilters.Darthvader]: ["equalizer", "timescale"],
    [AvailableFilters.Daycore]: ["timescale"],
    [AvailableFilters.Doubletime]: ["timescale"],
    [AvailableFilters.Demon]: ["equalizer", "timescale"],
};
