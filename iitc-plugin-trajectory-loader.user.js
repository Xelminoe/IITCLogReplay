// ==UserScript==
// @id             iitc-plugin-trajectory-loader
// @name           IITC plugin: Trajectory Loader
// @category       Layer
// @version        2.0.001
// @match          https://intel.ingress.com/*
// @grant          none
// @run-at         document-end
// ==/UserScript==

(function wrapper(plugin_info) {
    if (typeof window.plugin !== 'function') window.plugin = function () {};
    plugin_info.pluginId = 'iitc-plugin-trajectory-loader';
    plugin_info.dateTimeVersion = '2026101502';
    plugin_info.buildName = 'beta';

    window.IITC = window.IITC || {};
    IITC.plugin = IITC.plugin || {};
    const PLUGIN_NS = (window.plugin.trajectoryLoader = window.plugin.trajectoryLoader || {});
    IITC.plugin.trajectoryLoader = PLUGIN_NS;
    const UI = (PLUGIN_NS.ui = PLUGIN_NS.ui || {});
    const STORE = (window._trajectoryStore = window._trajectoryStore || {
        files: [],         // [{name, size, loadedAt}]
        messages: [],      // merged & deduped, sorted ascending by time
        stats: {           // summary
            fileCount: 0,
            rawCount: 0,
            uniqueCount: 0,
            timeStart: null,
            timeEnd: null,
            players: {}      // { playerName: count } - optional pre-aggregation for next steps
        }
    });
    if (!Object.prototype.hasOwnProperty.call(STORE, 'snapshot')) STORE.snapshot = null;

    // ---------- Colors / Player palette ----------
    const COLORS = (function() {
        const LS_KEY = 'iitc.tl.playerColors';
        const LS_SEL = 'iitc.tl.selectedPlayers';

        const TEAM_COLORS = {
            RESISTANCE: '#1E90FF',
            ENLIGHTENED: '#32CD32',
            NEUTRAL: '#9E9E9E',
            MACHINA: '#FF1744'
        };

        // 预生成一个长度足够的自动调色盘（黄金角度）
        const AUTO = [];
        (function makeAutoPalette(n = 128) {
            let h = 0;
            for (let i = 0; i < n; i++) {
                h = (h + 137.508) % 360;
                const s = 70, l = 50;
                AUTO.push(`hsl(${h.toFixed(1)}, ${s}%, ${l}%)`);
            }
        })();

        let overrides = {};   // { playerName: '#rrggbb' }
        let selected = [];    // ['Alice','Bob',...]

        // load/save
        function load() {
            try { overrides = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch(e){ overrides = {}; }
            try { selected  = JSON.parse(localStorage.getItem(LS_SEL) || '[]')  || []; } catch(e){ selected  = []; }
        }
        function save() {
            localStorage.setItem(LS_KEY, JSON.stringify(overrides));
            localStorage.setItem(LS_SEL, JSON.stringify(selected));
        }
        load();

        // 根据玩家名稳定映射到自动盘索引（用于无覆盖、无团队时）
        function autoColorFor(name) {
            const s = String(name || '');
            let h = 2166136261 >>> 0;
            for (let i = 0; i < s.length; i++) {
                h ^= s.charCodeAt(i);
                h = Math.imul(h, 16777619) >>> 0;
            }
            return AUTO[h % AUTO.length];
        }

        // 解析颜色：覆盖 > 团队默认 > 自动
        function resolve(name, team) {
            if (name && overrides[name]) return overrides[name];
            if (team && TEAM_COLORS[team]) return TEAM_COLORS[team];
            return autoColorFor(name);
        }

        // A link is owned by its creator/faction, not by the player who
        // eventually destroys it. Destruction-only records therefore fall
        // back to the destroyed link's faction color.
        function resolveLink(createdBy, faction) {
            if (createdBy && overrides[createdBy]) return overrides[createdBy];
            if (faction && TEAM_COLORS[faction]) return TEAM_COLORS[faction];
            return TEAM_COLORS.NEUTRAL;
        }

        // API
        return {
            TEAM_COLORS,
            get overrides() { return overrides; },
            get selected() { return selected.slice(); },
            isSelected(name) { return selected.includes(name); },

            resolve,
            resolveLink,

            setOverride(name, color) {
                if (!name || !color) return;
                overrides[name] = color;
                save();
            },
            resetOverride(name) {
                delete overrides[name];
                save();
            },
            clearOverrides() {
                overrides = {};
                save();
            },
            setSelected(arr) {
                selected = Array.from(new Set((arr || []).filter(Boolean)));
                save();
            },
            addSelected(name) {
                if (!name) return;
                if (!selected.includes(name)) selected.push(name);
                save();
            },
            removeSelected(name) {
                const i = selected.indexOf(name);
                if (i >= 0) selected.splice(i, 1);
                save();
            },
            exportJSON() {
                return JSON.stringify({ overrides, selected }, null, 2);
            },
            importJSON(text) {
                const obj = JSON.parse(text);
                if (obj && typeof obj === 'object') {
                    if (obj.overrides && typeof obj.overrides === 'object') overrides = obj.overrides;
                    if (Array.isArray(obj.selected)) selected = obj.selected.filter(Boolean);
                    save();
                }
            }
        };
    })();

    function refreshColors() {
        // 你的 halo/lifecycle/trajectory 图层对象请在 RENDER.state 内统一管理
        try { RENDER.halos?.refresh?.(); } catch(e){}
        try {
            for (const seg of (RENDER.state?.segments || [])) {
                const color = COLORS.resolve(seg.player, seg.team || seg.faction || null);
                seg.polyline?.setStyle({ color });
                seg.arrow1?.setStyle({ color });
                seg.arrow2?.setStyle({ color });
            }
            if (RENDER.player?.idx >= 0) RENDER.player.highlight(RENDER.player.idx);
        } catch(e){}
        try {
            if (RENDER.config.showSegmentsInOverview) {
                // 窗口化轨迹：复用当前订阅的 players 集合
                const players = (RENDER.segmentsWindow && RENDER.segmentsWindow.players) ? RENDER.segmentsWindow.players : COLORS.selected;
                if (RENDER._windowRenderCache) RENDER._windowRenderCache.visibleKey = null;
                if (players && players.length) RENDER.renderSegmentsWindowedForPlayers(players);
            }
        } catch(e){}
    }

    // ---------- Helpers ----------
    // Robust time extractor for IITC parsed messages (support several shapes).
    function getMsgTime(m) {
        // Raw COMM responses use [guid, timestamp, payload].
        if (Array.isArray(m) && typeof m[1] === 'number') return m[1];
        // Typical IITC parsed message has 'time' in ms.
        if (typeof m?.time === 'number') return m.time;
        // Some shapes keep timestamp in plext.timestampMs
        if (typeof m?.plext?.timestampMs === 'number') return m.plext.timestampMs;
        // Fallback: try 'ts'
        if (typeof m?.ts === 'number') return m.ts;
        return null;
    }

    // Robust guid extractor (parsed messages should carry guid).
    function getMsgGuid(m) {
        if (Array.isArray(m) && typeof m[0] === 'string') return m[0];
        if (typeof m?.guid === 'string') return m.guid;
        if (typeof m?.plext?.guid === 'string') return m.plext.guid;
        return null;
    }

    // Tiny non-crypto hash to build a stable fallback key if guid is missing.
    function tinyHash(str) {
        let h = 2166136261 >>> 0; // FNV-like
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619) >>> 0;
        }
        return (h >>> 0).toString(36);
    }

    // Build dedup key: prefer guid+time; fall back to hash(JSON).
    function buildKey(m) {
        const t = getMsgTime(m);
        const g = getMsgGuid(m);
        if (g && typeof t === 'number') return `${g}|${t}`;
        if (typeof t === 'number') return `t|${t}|${tinyHash(JSON.stringify(m))}`;
        return `x|${tinyHash(JSON.stringify(m))}`;
    }

    // Hints for player name extraction (best-effort, we’ll refine in Step 2).
    function getPlayerName(m) {
        const payload = Array.isArray(m) ? m[2] : m;
        if (typeof m?.player === 'string') return m.player;
        if (typeof payload?.player === 'string') return payload.player;
        if (typeof payload?.player?.name === 'string') return payload.player.name;
        if (typeof payload?.plext?.plextOwner === 'string') return payload.plext.plextOwner;
        // Sometimes in markup as ['PLAYER', {..., plain: 'Name'}]
        const markup = getMsgMarkup(m);
        if (Array.isArray(markup)) {
            for (const entry of markup) {
                if (entry && entry[0] === 'PLAYER' && entry[1]?.plain) return entry[1].plain;
            }
        }
        return null;
    }

    // Accept both IITC's parsed message objects and raw COMM payloads.
    function getMsgMarkup(m) {
        const payload = Array.isArray(m) ? m[2] : m;
        if (Array.isArray(payload?.markup)) return payload.markup;
        if (Array.isArray(payload?.plext?.markup)) return payload.plext.markup;
        return [];
    }

    function formatTs(ms) {
        if (typeof ms !== 'number') return 'N/A';
        const d = new Date(ms);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    // ---- Event model ----
    // type Event = {
    //   ts: number;
    //   type: 'capture' | 'deploy' | 'link';
    //   player: string;
    //   portals: { guid?: string; lat: number; lng: number; name?: string }[]; // capture/deploy: 1; link: 2
    //   raw: any;
    // };

    function normLatLngFromE6(latE6, lngE6) {
        if (typeof latE6 === 'number' && typeof lngE6 === 'number') {
            return { lat: latE6 / 1e6, lng: lngE6 / 1e6 };
        }
        return null;
    }

    function extractPortalsFromMarkup(markup) {
        // returns array of { guid?, lat, lng, name? }
        const out = [];
        if (!Array.isArray(markup)) return out;
        for (const entry of markup) {
            if (!entry || entry[0] !== 'PORTAL') continue;
            const p = entry[1] || {};
            const norm = normLatLngFromE6(p.latE6, p.lngE6);
            if (!norm) continue;
            out.push({
                guid: typeof p.guid === 'string' ? p.guid : undefined,
                lat: norm.lat,
                lng: norm.lng,
                name: typeof p.name === 'string' ? p.name : undefined,
            });
        }
        return out;
    }

    function extractTextFromMarkup(markup) {
        // Join TEXT tokens with spaces so adjacent tokens cannot merge words.
        if (!Array.isArray(markup)) return '';
        const parts = [];
        for (const entry of markup) {
            if (entry && entry[0] === 'TEXT' && entry[1]?.plain) {
                parts.push(entry[1].plain);
            }
        }
        return parts.join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
    }

    // Helper: extract player's team from COMM markup.
    // Returns one of 'RESISTANCE' | 'ENLIGHTENED' | 'NEUTRAL' | 'MACHINA' | null
    function extractPlayerTeamFromMarkup(markup) {
        if (!Array.isArray(markup)) return null;

        // Known MACHINA glyph-like name (exact string). A very loose fallback
        // regex is provided in case of diacritic variance; remove it if you
        // prefer strict matching only.
        const MACHINA_PLAIN =
              "_̶̱̍_̴̳͉̆̈́M̷͔̤͒Ą̷̍C̴̼̕ͅH̶̹͕̼̾Ḭ̵̇̾̓N̵̺͕͒̀̍Ä̴̞̰́_̴̦̀͆̓_̷̣̈́";
        const maybeMachina = (s) =>
        s === MACHINA_PLAIN || /M.?A.?C.?H.?I.?N.?A/i.test((s || '').replace(/\p{M}/gu, ''));

        // Prefer PLAYER token if present
        for (const entry of markup) {
            if (entry && entry[0] === 'PLAYER' && entry[1]) {
                const plain = entry[1].plain || '';
                const team = entry[1].team || null;
                if (team === 'NEUTRAL' && maybeMachina(plain)) return 'MACHINA';
                if (team === 'RESISTANCE' || team === 'ENLIGHTENED' || team === 'NEUTRAL') return team;
            }
        }

        // Fallback: some system lines may include a FACTION token for MACHINA
        for (const entry of markup) {
            if (entry && entry[0] === 'FACTION' && entry[1]) {
                const t = entry[1].team;
                if (t === 'MACHINA') return 'MACHINA';
            }
        }

        return null;
    }

    // Helper: extract link's FACTION (color owner) from COMM markup.
    // Returns 'ENLIGHTENED' | 'RESISTANCE' | 'MACHINA' | 'NEUTRAL' | null
    function extractLinkFactionFromMarkup(markup) {
        if (!Array.isArray(markup)) return null;
        for (const entry of markup) {
            if (entry && entry[0] === 'FACTION' && entry[1]?.team) {
                const t = entry[1].team;
                if (t === 'ENLIGHTENED' || t === 'RESISTANCE' || t === 'MACHINA' || t === 'NEUTRAL') {
                    return t;
                }
            }
        }
        return null;
    }

    function extractEventFromMessage(m) {
        // returns Event or null if not spatial/irrelevant
        const ts = getMsgTime(m);
        if (typeof ts !== 'number') return null;

        const player = getPlayerName(m);
        const markup = getMsgMarkup(m);
        const portals = extractPortalsFromMarkup(markup);
        if (portals.length === 0) return null; // no spatial anchor

        const text = extractTextFromMarkup(markup);
        // Decide type: prefer # of portals + keywords as hints
        let type = null;
        let faction = null; // for link/link_destroyed color owner

        if (portals.length >= 2 && /\blinked\b/.test(text)) {
            type = 'link';
            if (portals.length > 2) portals.length = 2;
            if (portals.length < 2) return null;
            faction = extractLinkFactionFromMarkup(markup) || null;

        } else if (
            portals.length >= 2 &&
            (
                (text.includes('destroyed') && /\blink\b/.test(text)) ||
                /destroyed\s+the\s+.*\blink\b/.test(text)
            )
        ) {
            // "Agent X destroyed the <FACTION> Link <PORTAL> to <PORTAL>"
            type = 'link_destroyed';
            if (portals.length > 2) portals.length = 2;
            if (portals.length < 2) return null;
            faction = extractLinkFactionFromMarkup(markup) || null;

        } else if (text.includes('captured')) {
            type = 'capture';
            portals.length = 1;

        } else if (/\bdeployed\s+(?:a\s+)?resonator\s+on\b/.test(text)) {
            type = 'deploy';
            portals.length = 1;

        } else if (
            (text.includes('destroyed') && text.includes('resonator on')) ||
            /destroyed\s+(?:a|the)?\s*resonator\s+on/.test(text)
        ) {
            type = 'destroy_reso';
            portals.length = 1;

        } else {
            return null;
        }

        const team = extractPlayerTeamFromMarkup(markup) || null;

        // Fallback for link creations without FACTION token:
        // if the PLAYER resolves to MACHINA, treat the link as MACHINA-owned.
        if (type === 'link' && !faction && team === 'MACHINA') {
            faction = 'MACHINA';
        }

        return {
            ts,
            type,
            player: player || 'UNKNOWN',
            portals,
            team,           // 玩家方：仍保留（用于其它用途）
            faction,        // 链路方：新增（仅 link / link_destroyed 有意义）
            raw: m,
        };
    }

    function buildPlayerIndex(events) {
        // Returns { byName: { [player]: { count, byType, firstTs, lastTs } }, allPlayers: string[] }
        const byName = {};
        for (const ev of events) {
            const name = ev.player || 'UNKNOWN';
            const rec = byName[name] || (byName[name] = {
                count: 0,
                byType: { capture: 0, deploy: 0, link: 0, destroy_reso: 0, link_destroyed: 0 },
                firstTs: ev.ts,
                lastTs: ev.ts,
                team: null,
            });
            rec.count += 1;
            rec.byType[ev.type] = (rec.byType[ev.type] || 0) + 1;
            if (ev.ts < rec.firstTs) rec.firstTs = ev.ts;
            if (ev.ts > rec.lastTs) rec.lastTs = ev.ts;
            if (!rec.team && ev.team) rec.team = ev.team;
        }
        const allPlayers = Object.keys(byName).sort((a, b) => byName[b].count - byName[a].count);
        return { byName, allPlayers };
    }

    // ---- Track helpers ----

    // get the spatial anchor of an event according to rules:
    // - link: use the FIRST portal as operation location
    // - capture/deploy: use the single portal
    function getEventAnchor(ev) {
        if (!ev || !Array.isArray(ev.portals) || ev.portals.length === 0) return null;
        // Remark 2: for 'link', use the first portal as operation site
        const p = ev.portals[0];
        if (typeof p?.lat !== 'number' || typeof p?.lng !== 'number') return null;
        return {
            lat: p.lat,
            lng: p.lng,
            name: p.name,
            guid: p.guid
        };
    }

    // consider two portals the "same":
    // - if both have guid -> compare guid
    // - else compare lat/lng within a small epsilon
    function isSamePortal(a, b) {
        if (!a || !b) return false;
        if (a.guid && b.guid) return a.guid === b.guid;
        const eps = 1e-6; // ~0.11m in lat; good enough here
        return Math.abs(a.lat - b.lat) < eps && Math.abs(a.lng - b.lng) < eps;
    }

    function haversineKm(lat1, lng1, lat2, lng2) {
        const toRad = (d) => (d * Math.PI) / 180;
        const R = 6371; // km
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const s1 = Math.sin(dLat / 2);
        const s2 = Math.sin(dLng / 2);
        const a = s1 * s1 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * s2 * s2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    function formatDuration(ms) {
        if (ms <= 0) return '0s';
        const sec = Math.floor(ms / 1000);
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        const parts = [];
        if (h) parts.push(h + 'h');
        if (m) parts.push(m + 'm');
        if (s || (!h && !m)) parts.push(s + 's');
        return parts.join(' ');
    }

    function formatDateTime(ms) {
        const d = new Date(ms);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    // Weight resolver: fall back to 1.0 when missing
    function _weightOfEventType(type) {
        const map = (RENDER.config && RENDER.config.trajWeightsByType) || {};
        const w = map[type];
        return (typeof w === 'number' && isFinite(w)) ? w : 0.0;
    }

    // ---- Arrow helpers ----
    function bearingDeg(lat1, lng1, lat2, lng2) {
        const toRad = d => d * Math.PI / 180;
        const toDeg = r => r * 180 / Math.PI;
        const φ1 = toRad(lat1), φ2 = toRad(lat2);
        const Δλ = toRad(lng2 - lng1);
        const y = Math.sin(Δλ) * Math.cos(φ2);
        const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
        return (toDeg(Math.atan2(y, x)) + 360) % 360;
    }

    function destPoint(lat, lng, distMeters, bearingDegVal) {
        const R = 6371000; // meters
        const δ = distMeters / R;
        const θ = bearingDegVal * Math.PI / 180;
        const φ1 = lat * Math.PI / 180;
        const λ1 = lng * Math.PI / 180;

        const sinφ1 = Math.sin(φ1), cosφ1 = Math.cos(φ1);
        const sinδ = Math.sin(δ), cosδ = Math.cos(δ);

        const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ);
        const φ2 = Math.asin(sinφ2);
        const y = Math.sin(θ) * sinδ * cosφ1;
        const x = cosδ - sinφ1 * sinφ2;
        const λ2 = λ1 + Math.atan2(y, x);

        return { lat: φ2 * 180 / Math.PI, lng: ((λ2 * 180 / Math.PI + 540) % 360) - 180 };
    }

    // Build two short lines as an arrow head at the end of the segment.
    // scale: meters; angle: degrees from the back-direction.
    function buildArrowHeadCoords(fromPt, toPt, scaleMeters = 16, angle = 28) {
        const brg = bearingDeg(fromPt.lat, fromPt.lng, toPt.lat, toPt.lng);
        // Arrow wings are drawn backwards from end point
        const back = (brg + 180) % 360;
        const left = (back - angle + 360) % 360;
        const right = (back + angle) % 360;

        const leftPt = destPoint(toPt.lat, toPt.lng, scaleMeters, left);
        const rightPt = destPoint(toPt.lat, toPt.lng, scaleMeters, right);

        // Return two line segments [[end, left], [end, right]]
        return [
            [[toPt.lat, toPt.lng], [leftPt.lat, leftPt.lng]],
            [[toPt.lat, toPt.lng], [rightPt.lat, rightPt.lng]]
        ];
    }

    // Build a Leaflet circle as "uncertainty halo" for an event at its anchor.
    function buildUncertaintyHalo(ev) {
        const anchor = getEventAnchor(ev);
        if (!anchor) return null;
        const r = RENDER.config.radiusByType?.[ev.type] ?? 40;
        const color = COLORS.resolve(ev.player, ev.team || ev.faction || null);
        return L.circle([anchor.lat, anchor.lng], {
            radius: r,
            color,
            weight: RENDER.config.haloStroke,
            opacity: RENDER.config.haloOpacity,
            dashArray: RENDER.config.haloDashArray,
            fill: true,
            fillOpacity: RENDER.config.haloFillOpacity
        });
    }

    // For link_destroyed later: build halos at both endpoints (if available).
    function buildDualHalosForLink(ev) {
        const pts = Array.isArray(ev.portals) ? ev.portals.slice(0,2) : [];
        if (pts.length < 2) return [];
        const color = COLORS.resolve(ev.player, ev.team || ev.faction || null);
        const r = RENDER.config.radiusByType?.link_destroyed ?? 168;
        return pts.map(p => L.circle([p.lat, p.lng], {
            radius: r,
            color,
            weight: RENDER.config.haloStroke,
            opacity: RENDER.config.haloOpacity,
            dashArray: RENDER.config.haloDashArray,
            fill: true,
            fillOpacity: RENDER.config.haloFillOpacity
        }));
    }

    // ---------- File reading ----------
    function readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
            reader.onload = () => resolve(String(reader.result || ''));
            reader.readAsText(file);
        });
    }

    function canonicalPortalKey(portal) {
        if (portal?.guid) return `g:${portal.guid}`;
        const lat = Number(portal?.lat);
        const lng = Number(portal?.lng);
        return Number.isFinite(lat) && Number.isFinite(lng)
            ? `c:${lat.toFixed(6)},${lng.toFixed(6)}`
            : null;
    }

    function canonicalLinkKey(a, b) {
        const left = canonicalPortalKey(a);
        const right = canonicalPortalKey(b);
        if (!left || !right) return null;
        return left < right ? `${left}|${right}` : `${right}|${left}`;
    }

    function finiteTimestamp(...values) {
        for (const value of values) {
            if (value === null || value === undefined || value === '') continue;
            const number = Number(value);
            if (Number.isFinite(number)) return number;
        }
        return null;
    }

    function normalizeSnapshotFaction(value) {
        if (typeof value === 'string') {
            const faction = value.toUpperCase();
            if (faction === 'RESISTANCE' || faction === 'R') return 'RESISTANCE';
            if (faction === 'ENLIGHTENED' || faction === 'E') return 'ENLIGHTENED';
            if (faction === 'MACHINA' || faction === 'M') return 'MACHINA';
            if (faction === 'NEUTRAL' || faction === 'N') return 'NEUTRAL';
        }
        const teamId = Number(value);
        if (teamId === 1) return 'RESISTANCE';
        if (teamId === 2) return 'ENLIGHTENED';
        if (teamId === 3) return 'MACHINA';
        if (teamId === 0) return 'NEUTRAL';
        return null;
    }

    function snapshotPoint(guid, latE6, lngE6, fallback = null) {
        const lat = Number(latE6);
        const lng = Number(lngE6);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            return { guid: guid || undefined, lat: lat / 1e6, lng: lng / 1e6 };
        }
        if (!fallback) return null;
        const fallbackLat = Number(fallback.lat);
        const fallbackLng = Number(fallback.lng);
        if (!Number.isFinite(fallbackLat) || !Number.isFinite(fallbackLng)) return null;
        return { guid: guid || fallback.guid || undefined, lat: fallbackLat, lng: fallbackLng };
    }

    function collectSnapshotGeometry(value, result = []) {
        if (Array.isArray(value)) {
            for (const item of value) collectSnapshotGeometry(item, result);
        } else if (value && typeof value === 'object') {
            const lat = Number(value.lat);
            const lng = Number(value.lng);
            if (Number.isFinite(lat) && Number.isFinite(lng)) result.push({ lat, lng });
        }
        return result;
    }

    function loadSnapshotObject(parsed, metadata = {}) {
        if (!parsed || parsed.format !== 'iitc-map-snapshot' || !Array.isArray(parsed.links)) {
            throw new Error('Expected an IITC Snapshot Exporter JSON file');
        }
        const capturedAtMs = finiteTimestamp(parsed.capturedAtMs, Date.parse(parsed.capturedAt || ''));
        if (capturedAtMs === null) throw new Error('Snapshot has no valid capture time');

        const portalPositions = new Map();
        for (const portal of Array.isArray(parsed.portals) ? parsed.portals : []) {
            const data = portal?.data || {};
            const guid = String(portal?.guid ?? data.guid ?? '');
            if (!guid) continue;
            const point = snapshotPoint(guid, data.latE6, data.lngE6, portal.position);
            if (point) portalPositions.set(guid, point);
        }

        const byKey = new Map();
        let skippedLinks = 0;
        let duplicateLinks = 0;
        for (const link of parsed.links) {
            const data = link?.data || {};
            const raw = Array.isArray(link?.rawEntity) ? link.rawEntity : null;
            const rawData = Array.isArray(raw?.[2]) ? raw[2] : null;
            const originGuid = data.oGuid ?? rawData?.[2] ?? null;
            const destinationGuid = data.dGuid ?? rawData?.[5] ?? null;
            const geometry = collectSnapshotGeometry(link?.geometry);
            const origin = snapshotPoint(
                originGuid,
                data.oLatE6 ?? rawData?.[3],
                data.oLngE6 ?? rawData?.[4],
                portalPositions.get(String(originGuid)) || geometry[0]
            );
            const destination = snapshotPoint(
                destinationGuid,
                data.dLatE6 ?? rawData?.[6],
                data.dLngE6 ?? rawData?.[7],
                portalPositions.get(String(destinationGuid)) || geometry[1]
            );
            const key = canonicalLinkKey(origin, destination);
            if (!origin || !destination || !key) {
                skippedLinks += 1;
                continue;
            }
            const normalized = {
                key,
                guid: String(link?.guid ?? data.guid ?? raw?.[0] ?? ''),
                a: origin,
                b: destination,
                timestamp: finiteTimestamp(link?.timestamp, data.timestamp, raw?.[1]),
                capturedAtMs,
                faction: normalizeSnapshotFaction(data.team ?? link?.team ?? rawData?.[1]),
                source: 'snapshot'
            };
            const previous = byKey.get(key);
            if (previous) {
                duplicateLinks += 1;
                if ((normalized.timestamp ?? -Infinity) < (previous.timestamp ?? -Infinity)) continue;
            }
            byKey.set(key, normalized);
        }

        STORE.snapshot = {
            name: String(metadata.name || 'snapshot.json'),
            size: Number(metadata.size) || 0,
            loadedAt: Date.now(),
            capturedAtMs,
            capturedAt: parsed.capturedAt || new Date(capturedAtMs).toISOString(),
            sourceCounts: {
                portals: Array.isArray(parsed.portals) ? parsed.portals.length : 0,
                links: parsed.links.length,
                fields: Array.isArray(parsed.fields) ? parsed.fields.length : 0
            },
            links: Array.from(byKey.values()),
            skippedLinks,
            duplicateLinks
        };
        return STORE.snapshot;
    }

    async function loadSnapshotFile(file) {
        let parsed;
        try {
            parsed = JSON.parse(await readFileAsText(file));
        } catch (error) {
            throw new Error(`Invalid snapshot JSON: ${error?.message || error}`);
        }
        return loadSnapshotObject(parsed, { name: file.name, size: file.size });
    }

    const SNAPSHOT = (PLUGIN_NS.snapshot = PLUGIN_NS.snapshot || {});
    SNAPSHOT.loadObject = loadSnapshotObject;
    SNAPSHOT.loadFile = loadSnapshotFile;
    SNAPSHOT.clear = () => { STORE.snapshot = null; };
    Object.defineProperty(SNAPSHOT, 'current', { configurable: true, get: () => STORE.snapshot });

    async function loadAndMerge(files, progressCb) {
        const summaries = [];
        const allMessages = [];
        let rawCount = 0;

        // 1) read all files (in parallel)
        const texts = await Promise.all(files.map(readFileAsText));

        // 2) parse and collect messages
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            let parsed;
            try {
                parsed = JSON.parse(texts[i]);
            } catch (e) {
                summaries.push({ name: f.name, ok: false, reason: 'Invalid JSON' });
                progressCb?.(`❌ ${f.name}: invalid JSON`);
                continue;
            }

            const arr = Array.isArray(parsed)
                ? parsed
                : Array.isArray(parsed?.messages)
                    ? parsed.messages
                    : Array.isArray(parsed?.result)
                        ? parsed.result
                        : null;
            if (!arr) {
                summaries.push({ name: f.name, ok: false, reason: 'Missing COMM message array' });
                progressCb?.(`❌ ${f.name}: expected an array, "messages", or "result"`);
                continue;
            }

            // Avoid spreading very large logs into function arguments.
            for (const message of arr) allMessages.push(message);
            rawCount += arr.length;
            summaries.push({ name: f.name, ok: true, count: arr.length });
            progressCb?.(`📦 ${f.name}: ${arr.length} messages`);
        }

        // 3) deduplicate
        const seen = new Set();
        const deduped = [];
        for (const m of allMessages) {
            const key = buildKey(m);
            if (!seen.has(key)) {
                seen.add(key);
                deduped.push(m);
            }
        }

        // 4) sort by time asc
        deduped.sort((a, b) => {
            const ta = getMsgTime(a) ?? 0;
            const tb = getMsgTime(b) ?? 0;
            return ta - tb;
        });

        // 5) compute stats
        const timedMessages = deduped.filter(m => typeof getMsgTime(m) === 'number');
        const timeStart = timedMessages.length ? getMsgTime(timedMessages[0]) : null;
        const timeEnd = timedMessages.length ? getMsgTime(timedMessages[timedMessages.length - 1]) : null;
        const players = {};
        for (const m of deduped) {
            const p = getPlayerName(m);
            if (p) players[p] = (players[p] || 0) + 1;
        }

        // 6) extract spatial events (capture/deploy/link) and build player index
        const events = [];
        const parseStats = {
            withMarkup: 0,
            withoutMarkup: 0,
            withoutPortal: 0,
            unsupportedAction: 0,
            byType: {}
        };
        for (const m of deduped) {
            const markup = getMsgMarkup(m);
            if (!markup.length) {
                parseStats.withoutMarkup += 1;
                continue;
            }
            parseStats.withMarkup += 1;
            if (!extractPortalsFromMarkup(markup).length) {
                parseStats.withoutPortal += 1;
                continue;
            }
            const ev = extractEventFromMessage(m);
            if (ev) {
                events.push(ev);
                parseStats.byType[ev.type] = (parseStats.byType[ev.type] || 0) + 1;
            } else {
                parseStats.unsupportedAction += 1;
            }
        }
        // sort events by time asc just in case
        events.sort((a, b) => a.ts - b.ts);

        const { byName: playerIndex, allPlayers } = buildPlayerIndex(events);

        // 7) update global store
        const validFileNames = new Set(summaries.filter(s => s.ok).map(s => s.name));
        STORE.files = files
            .filter(f => validFileNames.has(f.name))
            .map(f => ({ name: f.name, size: f.size, loadedAt: Date.now() }));
        STORE.messages = deduped;             // raw (deduped)
        STORE.events = events;                // normalized spatial events
        STORE.playerIndex = playerIndex;      // { [name]: { count, byType, firstTs, lastTs } }
        STORE.stats = {
            fileCount: STORE.files.length,
            rawCount,
            uniqueCount: deduped.length,
            timeStart: timeStart ?? null,
            timeEnd: timeEnd ?? null,
            playersTotal: allPlayers.length,    // number of players with spatial events
            spatialEvents: events.length,
            parseStats,
        };
        // ─────────────────────────────────────────────────────────────
        // Timeline index (sorted events + binary search helpers)
        // ─────────────────────────────────────────────────────────────
        STORE.timeline = {
            events: [], // to be set after files are loaded (sorted ascending by ts)
            lowerBound(ts) { // first idx with e.ts >= ts
                const a = this.events; let lo = 0, hi = a.length;
                while (lo < hi) { const mid = (lo + hi) >> 1; (a[mid].ts < ts) ? (lo = mid + 1) : (hi = mid); }
                return lo;
            },
            upperBound(ts) { // first idx with e.ts > ts
                const a = this.events; let lo = 0, hi = a.length;
                while (lo < hi) { const mid = (lo + hi) >> 1; (a[mid].ts <= ts) ? (lo = mid + 1) : (hi = mid); }
                return lo;
            }
        };
        // after parsing all input files into STORE.events (ascending by ts)
        STORE.timeline.events = (STORE.events || []).slice().sort((a,b)=>a.ts-b.ts);
        if (STORE.timeline.events.length) {
            const evs = STORE.timeline.events;
            RENDER.clock.setRange(evs[0].ts, evs[evs.length-1].ts);
        }

        return {
            summaries,
            rawCount,
            uniqueCount: deduped.length,
            timeStart,
            timeEnd,
            playersTotal: allPlayers.length,
            spatialEvents: events.length,
            parseStats,
            topPlayers: allPlayers.slice(0, 10) // small preview
        };

    }

    // ---- Render / Tracks ----
    const RENDER = (PLUGIN_NS.render = PLUGIN_NS.render || {});

    RENDER.state = {
        layer: null,
        segments: [], // [{fromEv,toEv,fromPt,toPt,polyline,dKm,dtMs,kmh}]
        activeEvents: []
    };

    RENDER.config = {
        strokeColor: '#800080', // purple
        strokeWeight: 3,
        strokeOpacity: 0.9,
        dashArray: '6, 6',
        doubtfulOpacity: 0.4,   // for impossible / flagged segments (reserved)
        maxSpeedKmh: null,       // if set (e.g. 300), segments above will be styled differently
        arrowColor: '#800080',
        arrowWeight: 2,
        arrowOpacity: 0.9,
        arrowScaleMin: 10,   // meters
        arrowScaleMax: 24,   // meters
        colorByTeam: {
            ENLIGHTENED: '#00b000',
            RESISTANCE:  '#007bff',
            MACHINA:     '#cc0000',
            NEUTRAL:     '#808080'
        },
        colorByPlayer: {},
        // Uncertainty halos
        haloStroke: 1.5,
        haloOpacity: 0.35,
        haloFillOpacity: 0.12,
        haloDashArray: '4, 4',
        radiusByType: {  // meters
            capture: 40, deploy: 40, link: 40,
            destroy_reso: 168, link_destroyed: 168
        },
        // Trajectory / segments rendering policy
        showSegmentsInOverview: false,   // 默认关闭：overview 不画整段轨迹
        segWindowPastMs:  10 * 60 * 1000, // 跟随模式/窗口渲染：过去 10 分钟
        segWindowFutureMs: 0 * 60 * 1000,     // 跟随模式/窗口渲染：未来 0 秒
        segShowArrows: true,              // full trail shows arrows; overview temporarily disables them
        linksFromAll: true,               // match link creation/destruction across different players

        // Halos time window：仅显示 [now - past, now + future] 内的事件圈
        haloWindowPastMs:  60 * 1000,   // 过去 1 分钟
        haloWindowFutureMs: 60 * 1000,      // 未来 60 秒

        // Halos 淡出动画（离开窗口时才触发）
        haloFadeDuration: 1200,             // 毫秒
        haloFadeSteps: 6,                   // 离散淡出步数

        // Halos 基础样式（若之前未加）
        haloStroke: 1.5,
        haloOpacity: 0.35,
        haloFillOpacity: 0.12,
        haloDashArray: '4, 4',

        // 半径映射（若之前未加）
        radiusByType: {
            capture: 40, deploy: 40, link: 40,
            destroy_reso: 168, link_destroyed: 168 // 注意：destroy_link 仅用于链生命周期提示，不做位置推断
        },

        // Low-zoom visibility for 40m halos
        haloMinPixelRadius: 12,     // 如果屏幕上的半径 < 12px，则启用低缩放渲染
        haloLowZoomMode: 'marker',  // 'marker' 用 circleMarker 替代；'hide' 直接不画

        // Attack visualization (for destroy_reso)
        attackWindowPastMs: 10 * 60 * 1000,  // find prev 40m event within 10 min (or 250m)
        attackWindowFutureMs: 10 * 60 * 1000, // find next 40m event within 10 min (or 250m)
        attackSpatialThresholdM: 250,        // 250 m
        attackWedgeRadiusM: 40,              // arc radius at portal = 40 m
        attackWedgeMinDeg: 40,               // clamp wedge angle [min, max]
        attackWedgeMaxDeg: 140,
        attackTickLenM: 8,                   // outward normal tick length in meters
        attackTickWidth: 2,                  // px
        attackFadeDuration: 1200,            // ms fade-out when leaving time window
        attackFadeSteps: 6,                  // steps
        attackColorOpacity: 0.22,            // wedge fill opacity
        attackStrokeOpacity: 0.45,           // wedge stroke opacity
        attackRingRadiusM: 10,               // "hit" circle
        attackRingStroke: 2,                 // px
        attackRingPulseScale: 1.2,           // pulse 1.0 -> 1.2 -> 1.0
        attackRingPulseMs: 260,              // pulse one shot
        linkStroke: 3,
        linkOpacity: 0.85,
        linkFadeDuration: 800,  // ms
        linkFadeSteps: 5,

        // Playback speed presets (virtual time multiplier)
        speedPresets: [1, 10, 25, 50, 100, 200, 400],
        defaultSpeedIndex: 3, // 0-based index in speedPresets (here: 50×)
        // Trajectory: weighted centroid smoothing
        trajUseWeightedNodes: true,     // 打开后，段的端点用加权平均后的坐标
        trajSmoothWindowMs: 1 * 60 * 1000, // 以节点 ts 为中心 ±1 分钟（可调）
        trajWeightsByType: {           // 事件类型权重
            capture: 1.0,
            deploy: 1.0,
            link: 1.0,
            destroy_reso: 0.15           // 明显小于其它事件
        },
        trajMinWeightSum: 0.5,         // 加权窗口里总权重低于该值则退回原始锚点
        interactionRadiusByType: {
            capture: 40,
            deploy: 40,
            link: 40
        },
        destroyPortalRadiusM: 40,      // resonators may be deployed this far from the portal
        destroyWeaponRangeM: 168,      // conservative maximum XMP distance to a resonator
        destroyFalloffStrength: 0.35,  // nonlinear inward prior; not an exact damage formula
        interactionProjectionSteps: 16,
        trajContinuityWeight: 0.03,    // weak distance preference only; no turn/curvature penalty
        trajContinuityPasses: 2

    };

    // One shared inferred-position model for map tracks and GIF player markers.
    // Every node is an observed action time with a spatial estimate; positions
    // between nodes are linearly interpolated on the real timeline.
    const POSITION_MODEL = (function () {
        const evidenceTypes = new Set(['capture', 'deploy', 'link', 'destroy_reso']);
        let cachedEvents = null;
        let cachedConfigKey = '';
        let cachedSeries = new Map();

        function configKey() {
            const weights = RENDER.config.trajWeightsByType || {};
            const radii = RENDER.config.interactionRadiusByType || {};
            return JSON.stringify([
                RENDER.config.trajUseWeightedNodes !== false,
                Number(RENDER.config.trajSmoothWindowMs) || 0,
                Number(RENDER.config.trajMinWeightSum) || 0,
                ...Array.from(evidenceTypes).map(type => Number(weights[type]) || 0),
                Number(radii.capture) || 0,
                Number(radii.deploy) || 0,
                Number(radii.link) || 0,
                Number(RENDER.config.destroyPortalRadiusM) || 0,
                Number(RENDER.config.destroyWeaponRangeM) || 0,
                Number(RENDER.config.destroyFalloffStrength) || 0,
                Number(RENDER.config.interactionProjectionSteps) || 0,
                Number(RENDER.config.trajContinuityWeight) || 0,
                Number(RENDER.config.trajContinuityPasses) || 0
            ]);
        }

        function rawPointOf(group) {
            let sumW = 0, sumLat = 0, sumLng = 0;
            for (const item of group) {
                const w = item.weight > 0 ? item.weight : 1;
                sumW += w;
                sumLat += item.anchor.lat * w;
                sumLng += item.anchor.lng * w;
            }
            return sumW > 0
                ? { lat: sumLat / sumW, lng: sumLng / sumW }
                : null;
        }

        function shortestLngDelta(fromLng, toLng) {
            return ((toLng - fromLng + 540) % 360) - 180;
        }

        function normalizeLng(lng) {
            return ((lng + 540) % 360) - 180;
        }

        function moveTowardFraction(from, to, fraction) {
            const f = Math.max(0, Math.min(1, Number(fraction) || 0));
            return {
                lat: from.lat + (to.lat - from.lat) * f,
                lng: normalizeLng(from.lng + shortestLngDelta(from.lng, to.lng) * f)
            };
        }

        function distanceMeters(a, b) {
            return haversineKm(a.lat, a.lng, b.lat, b.lng) * 1000;
        }

        function projectIntoCircle(point, center, radiusM) {
            const d = distanceMeters(point, center);
            if (!Number.isFinite(d) || d <= radiusM || d <= 1e-6) return { ...point };
            return moveTowardFraction(center, point, radiusM / d);
        }

        function interactionRadiusForEvent(ev) {
            if (ev?.type === 'destroy_reso') {
                return Math.max(0, Number(RENDER.config.destroyPortalRadiusM) || 40) +
                    Math.max(0, Number(RENDER.config.destroyWeaponRangeM) || 168);
            }
            const configured = Number(RENDER.config.interactionRadiusByType?.[ev?.type]);
            return Number.isFinite(configured) && configured >= 0 ? configured : null;
        }

        function constrainPoint(basePoint, items, applyDestroyFalloff) {
            let point = { lat: basePoint.lat, lng: basePoint.lng };
            const portalRadius = Math.max(0, Number(RENDER.config.destroyPortalRadiusM) || 40);
            const weaponRange = Math.max(0, Number(RENDER.config.destroyWeaponRangeM) || 168);
            const falloffStrength = Math.max(0, Number(RENDER.config.destroyFalloffStrength) || 0);
            const constraints = [];

            for (const item of items) {
                const radiusM = interactionRadiusForEvent(item.ev);
                if (radiusM == null) continue;
                constraints.push({
                    center: item.anchor,
                    radiusM,
                    // Destruction is a broader, weaker location observation.
                    weight: item.ev.type === 'destroy_reso' ? Math.max(0.25, item.weight) : Math.max(1, item.weight)
                });

                if (applyDestroyFalloff && item.ev.type === 'destroy_reso' && weaponRange > 0 && falloffStrength > 0) {
                    point = projectIntoCircle(point, item.anchor, portalRadius + weaponRange);
                    const portalDistance = distanceMeters(point, item.anchor);
                    const weaponDistance = Math.max(0, portalDistance - portalRadius);
                    const ratio = Math.max(0, Math.min(1, weaponDistance / weaponRange));
                    // A steep but deliberately approximate likelihood prior: far
                    // XMP hits remain possible, while nearer hits are preferred.
                    const pull = Math.min(0.8, falloffStrength * (1 - Math.exp(-3 * ratio * ratio)));
                    point = moveTowardFraction(point, item.anchor, pull);
                }
            }

            // Average projections are order-independent. If the interaction
            // disks overlap this converges inside them; conflicting simultaneous
            // evidence settles at a weighted soft compromise instead of failing.
            const steps = Math.max(1, Math.round(Number(RENDER.config.interactionProjectionSteps) || 1));
            for (let step = 0; step < steps && constraints.length; step++) {
                let sumLat = 0, sumLng = 0, sumWeight = 0;
                for (const constraint of constraints) {
                    const projected = projectIntoCircle(point, constraint.center, constraint.radiusM);
                    const violation = distanceMeters(point, constraint.center) - constraint.radiusM;
                    if (violation <= 1e-3) continue;
                    sumLat += (projected.lat - point.lat) * constraint.weight;
                    sumLng += shortestLngDelta(point.lng, projected.lng) * constraint.weight;
                    sumWeight += constraint.weight;
                }
                if (sumWeight <= 0) break;
                point = {
                    lat: point.lat + sumLat / sumWeight,
                    lng: normalizeLng(point.lng + sumLng / sumWeight)
                };
            }

            let maxViolationM = 0;
            for (const constraint of constraints) {
                maxViolationM = Math.max(
                    maxViolationM,
                    distanceMeters(point, constraint.center) - constraint.radiusM
                );
            }
            return { point, maxViolationM: Math.max(0, maxViolationM) };
        }

        function buildUncached(playerName, source) {
            const evidence = [];
            for (const ev of source) {
                if (!ev || ev.player !== playerName || !evidenceTypes.has(ev.type)) continue;
                const anchor = getEventAnchor(ev);
                if (!anchor || !Number.isFinite(ev.ts)) continue;
                evidence.push({ ev, anchor, weight: _weightOfEventType(ev.type) });
            }
            evidence.sort((a, b) => a.ev.ts - b.ev.ts);
            if (!evidence.length) return [];

            // Simultaneous actions are evidence for one position, not several
            // zero-duration moves, so collapse them into one timeline node.
            const groups = [];
            for (const item of evidence) {
                const ts = item.ev.ts;
                let group = groups[groups.length - 1];
                if (!group || group.ts !== ts) {
                    group = { ts, items: [] };
                    groups.push(group);
                }
                group.items.push(item);
            }

            const useWeighted = RENDER.config.trajUseWeightedNodes !== false;
            const win = Math.max(0, Number(RENDER.config.trajSmoothWindowMs) || 0);
            const minWeight = Math.max(0, Number(RENDER.config.trajMinWeightSum) || 0);
            let left = 0, right = 0;
            let sumW = 0, sumLat = 0, sumLng = 0;
            const nodes = [];

            for (const group of groups) {
                const lower = group.ts - win;
                const upper = group.ts + win;
                while (right < evidence.length && evidence[right].ev.ts <= upper) {
                    const item = evidence[right++];
                    if (item.weight > 0) {
                        sumW += item.weight;
                        sumLat += item.anchor.lat * item.weight;
                        sumLng += item.anchor.lng * item.weight;
                    }
                }
                while (left < evidence.length && evidence[left].ev.ts < lower) {
                    const item = evidence[left++];
                    if (item.weight > 0) {
                        sumW -= item.weight;
                        sumLat -= item.anchor.lat * item.weight;
                        sumLng -= item.anchor.lng * item.weight;
                    }
                }

                const rawPoint = rawPointOf(group.items);
                const baselinePoint = useWeighted && sumW >= minWeight && sumW > 0
                    ? { lat: sumLat / sumW, lng: sumLng / sumW }
                    : rawPoint;
                if (!baselinePoint) continue;
                const constrained = constrainPoint(baselinePoint, group.items, true);
                nodes.push({
                    ts: group.ts,
                    point: constrained.point,
                    baselinePoint,
                    rawPoint,
                    maxConstraintViolationM: constrained.maxViolationM,
                    event: group.items[group.items.length - 1].ev,
                    events: group.items.map(item => item.ev),
                    _items: group.items
                });
            }

            // Use only a weak adjacent-distance preference to choose among valid
            // points inside interaction disks. Forward/backward passes keep it
            // symmetric; there is intentionally no angle, curvature or
            // acceleration term, so sharp turns and immediate reversals remain.
            const continuity = Math.max(0, Math.min(1, Number(RENDER.config.trajContinuityWeight) || 0));
            const passes = Math.max(0, Math.round(Number(RENDER.config.trajContinuityPasses) || 0));
            for (let pass = 0; pass < passes && continuity > 0; pass++) {
                for (let i = 1; i < nodes.length; i++) {
                    const shifted = moveTowardFraction(nodes[i].point, nodes[i - 1].point, continuity);
                    const constrained = constrainPoint(shifted, nodes[i]._items, false);
                    nodes[i].point = constrained.point;
                    nodes[i].maxConstraintViolationM = constrained.maxViolationM;
                }
                for (let i = nodes.length - 2; i >= 0; i--) {
                    const shifted = moveTowardFraction(nodes[i].point, nodes[i + 1].point, continuity);
                    const constrained = constrainPoint(shifted, nodes[i]._items, false);
                    nodes[i].point = constrained.point;
                    nodes[i].maxConstraintViolationM = constrained.maxViolationM;
                }
            }
            for (const node of nodes) delete node._items;
            return nodes;
        }

        function seriesForPlayer(playerName, events = STORE.events) {
            const source = Array.isArray(events) ? events : [];
            if (source !== STORE.events) return buildUncached(playerName, source);

            const key = configKey();
            if (cachedEvents !== source || cachedConfigKey !== key) {
                cachedEvents = source;
                cachedConfigKey = key;
                cachedSeries = new Map();
            }
            if (!cachedSeries.has(playerName)) {
                cachedSeries.set(playerName, buildUncached(playerName, source));
            }
            return cachedSeries.get(playerName);
        }

        function positionAt(series, ts) {
            if (!Array.isArray(series) || !series.length || !Number.isFinite(ts)) return null;
            if (ts < series[0].ts) return null;
            const last = series[series.length - 1];
            if (ts >= last.ts) return { lat: last.point.lat, lng: last.point.lng };

            let lo = 0, hi = series.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (series[mid].ts <= ts) lo = mid + 1;
                else hi = mid;
            }
            const a = series[Math.max(0, lo - 1)];
            const b = series[lo];
            if (!a || !b || b.ts <= a.ts) return a?.point || b?.point || null;
            const ratio = Math.max(0, Math.min(1, (ts - a.ts) / (b.ts - a.ts)));
            return {
                lat: a.point.lat + (b.point.lat - a.point.lat) * ratio,
                lng: a.point.lng + (b.point.lng - a.point.lng) * ratio
            };
        }

        return { evidenceTypes, interactionRadiusForEvent, seriesForPlayer, positionAt };
    })();
    RENDER.positionModel = POSITION_MODEL;
    PLUGIN_NS.positionModel = POSITION_MODEL;

    const LINK_LIFECYCLES = (function () {
        function build(startTs, endTs, options = {}) {
            const selectedSet = options.selectedSet instanceof Set ? options.selectedSet : null;
            const source = (Array.isArray(options.events) ? options.events : (STORE.events || []))
                .slice()
                .sort((a, b) => a.ts - b.ts);
            const result = [];
            const byKey = new Map();
            const open = new Map();
            const eventTimes = new Map();

            function addRecord(record) {
                result.push(record);
                let bucket = byKey.get(record.key);
                if (!bucket) byKey.set(record.key, bucket = []);
                bucket.push(record);
                return record;
            }

            for (const ev of source) {
                if ((ev.type !== 'link' && ev.type !== 'link_destroyed') || ev.portals?.length < 2) continue;
                const a = ev.portals[0];
                const b = ev.portals[1];
                const key = canonicalLinkKey(a, b);
                if (!key) continue;
                let times = eventTimes.get(key);
                if (!times) eventTimes.set(key, times = []);
                times.push(ev.ts);

                if (ev.type === 'link') {
                    const previous = open.get(key);
                    if (previous) previous.deadTs = Math.max(previous.bornTs + 1, ev.ts);
                    const record = addRecord({
                        key, a, b,
                        bornTs: ev.ts,
                        deadTs: Infinity,
                        faction: ev.faction || null,
                        createdBy: ev.player || null,
                        destroyedBy: null,
                        fromSnapshot: false,
                        snapshotGuid: null,
                        inferenceConflict: false
                    });
                    open.set(key, record);
                } else {
                    const record = open.get(key);
                    if (record) {
                        record.deadTs = Math.max(record.bornTs + 1, ev.ts);
                        record.destroyedBy = ev.player || null;
                        if (!record.faction && ev.faction) record.faction = ev.faction;
                        open.delete(key);
                    } else {
                        addRecord({
                            key, a, b,
                            bornTs: startTs,
                            deadTs: ev.ts,
                            faction: ev.faction || null,
                            createdBy: null,
                            destroyedBy: ev.player || null,
                            fromSnapshot: false,
                            snapshotGuid: null,
                            inferenceConflict: false
                        });
                    }
                }
            }

            let supplemented = 0;
            let matched = 0;
            let conflicts = 0;
            if (options.includeSnapshot !== false && STORE.snapshot?.links?.length) {
                for (const snapshotLink of STORE.snapshot.links) {
                    const key = snapshotLink.key || canonicalLinkKey(snapshotLink.a, snapshotLink.b);
                    if (!key) continue;
                    const capturedAt = finiteTimestamp(snapshotLink.capturedAtMs, STORE.snapshot.capturedAtMs);
                    if (capturedAt === null) continue;
                    const candidates = byKey.get(key) || [];
                    let observed = candidates.find(record =>
                        record.bornTs <= capturedAt && capturedAt < record.deadTs
                    );
                    if (observed) {
                        observed.fromSnapshot = true;
                        observed.snapshotGuid = snapshotLink.guid || null;
                        if (!observed.faction) observed.faction = snapshotLink.faction || null;
                        matched += 1;
                        continue;
                    }

                    // IITC link entity timestamps are not reliable creation
                    // times: field/tile updates can stamp an older baseline
                    // link with the time a later triangle was completed. A
                    // snapshot-only link is therefore initial state and starts
                    // at the replay boundary. Explicit COMM events still split
                    // or close its lifecycle below.
                    let bornTs = startTs;
                    let latestDeath = -Infinity;
                    for (const record of candidates) {
                        if (record.deadTs <= capturedAt) latestDeath = Math.max(latestDeath, record.deadTs);
                    }
                    let inferenceConflict = false;
                    if (bornTs > capturedAt || bornTs <= latestDeath) {
                        bornTs = capturedAt;
                        inferenceConflict = true;
                        conflicts += 1;
                    }
                    const nextBoundary = (eventTimes.get(key) || []).find(ts => ts > capturedAt) ?? Infinity;
                    addRecord({
                        key,
                        a: snapshotLink.a,
                        b: snapshotLink.b,
                        bornTs,
                        deadTs: nextBoundary,
                        faction: snapshotLink.faction || null,
                        createdBy: null,
                        destroyedBy: null,
                        fromSnapshot: true,
                        snapshotGuid: snapshotLink.guid || null,
                        inferenceConflict
                    });
                    supplemented += 1;
                }
            }

            const visible = result
                .filter(record => record.bornTs <= endTs && record.deadTs > startTs)
                .filter(record => !selectedSet || record.fromSnapshot ||
                    selectedSet.has(record.createdBy) || selectedSet.has(record.destroyedBy))
                .sort((left, right) => left.key.localeCompare(right.key) || left.bornTs - right.bornTs)
                .map((record, index) => ({
                    ...record,
                    id: `${record.key}#${index + 1}`,
                    deadTs: Number.isFinite(record.deadTs) ? record.deadTs : endTs + 1
                }));

            if (STORE.snapshot) {
                STORE.snapshot.lastMergeStats = {
                    supplemented,
                    matched,
                    conflicts,
                    visible: visible.filter(record => record.fromSnapshot).length
                };
            }
            return visible;
        }

        return { build };
    })();
    PLUGIN_NS.linkLifecycles = LINK_LIFECYCLES;

    // ─────────────────────────────────────────────────────────────
    // Virtual Clock (single source of time)
    // Provides: start/pause/seek/setRange/setSpeed and a subscription API.
    // All render systems should react to time via this clock.
    // ─────────────────────────────────────────────────────────────
    RENDER.clock = (function () {
        let playing = false;
        let t = 0, t0 = 0, tEnd = 0;
        let speed = 50;               // virtual time = real time * speed
        let timer = null;
        const listeners = new Set();  // callbacks: (tPrev:number, tNow:number) => void

        function _tick() {
            const frame = 50; // ms real time per tick (tune later)
            const tPrev = t;
            t = Math.min(t + frame * speed, tEnd);
            // fan-out
            for (const fn of listeners) { try { fn(tPrev, t); } catch (e) { console.warn(e); } }
            if (t >= tEnd) { pause(); return; }
            timer = setTimeout(_tick, frame);
        }

        function start() { if (!playing) { playing = true; _tick(); } }
        function pause() { playing = false; if (timer) clearTimeout(timer); timer = null; }
        function setNow(ts) { t = +ts; for (const fn of listeners) { try { fn(t, t); } catch {} } }
        function seek(ts) { pause(); setNow(ts); } // explicit seek (no drift)
        function setRange(start, end) {
            t0 = +start;
            tEnd = +end;
            if (t < t0) t = t0;
            if (t > tEnd) t = tEnd;
        }
        function setSpeed(s) { const v = Math.max(1, s|0); speed = v; return v; }

        return {
            start, pause, seek, setNow, setSpeed, setRange,
            on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
            get now() { return t; }, get playing() { return playing; },
            get startTs() { return t0; }, get endTs() { return tEnd; },
            get speed() { return speed; },
        };
    })();

    // Build contiguous segments from the same inferred position series used by
    // GIF markers, so both renderers describe one identical movement curve.
    RENDER.buildSegmentsForPlayer = function(playerName) {
        const series = POSITION_MODEL.seriesForPlayer(playerName);
        const segs = [];
        for (let i = 1; i < series.length; i++) {
            const prevNode = series[i - 1];
            const currNode = series[i];
            const prev = prevNode.event;
            const curr = currNode.event;
            const a1 = prevNode.point;
            const a2 = currNode.point;
            if (!a1 || !a2 || isSamePortal(a1, a2)) continue;

            const dKm = haversineKm(a1.lat, a1.lng, a2.lat, a2.lng);
            const dtMs = Math.max(0, currNode.ts - prevNode.ts);
            const kmh = (dtMs > 0 && dKm > 0.08) ? ((dKm - 0.08) / (dtMs / 3600000)) : 0;

            segs.push({
                fromEv: prev,
                toEv: curr,
                fromPt: a1,
                toPt: a2,
                dKm,
                dtMs,
                kmh,
                player: (curr.player || prev.player || null),
                team: (curr.team || prev.team || null),
                polyline: null // will be filled when rendering
            });
        }
        return segs;
    };

    // Build segments for multiple players, then merge by timeline (ascending).
    RENDER.buildSegmentsForPlayers = function(playerNames) {
        const names = Array.isArray(playerNames) ? playerNames.filter(Boolean) : [];
        if (names.length === 0) return [];

        // Build per-player segments using the existing single-player builder,
        // then concatenate and sort by start time.
        let merged = [];
        for (const name of names) {
            const segs = RENDER.buildSegmentsForPlayer(name) || [];
            // Ensure each segment carries its owner name (added previously)
            for (const s of segs) {
                if (!s.player) s.player = name;
            }
            merged = merged.concat(segs);
        }
        // Sort by the beginning timestamp (fromEv.ts), fallback to toEv.ts
        merged.sort((a, b) => {
            const ta = (a?.fromEv?.ts ?? a?.toEv?.ts ?? 0);
            const tb = (b?.fromEv?.ts ?? b?.toEv?.ts ?? 0);
            return ta - tb;
        });
        return merged;
    };

    // ---- Compact, offline GIF export ----
    // The exporter deliberately redraws the trajectory on a clean canvas rather
    // than copying IITC's map. This keeps the canvas origin-clean (map tiles are
    // commonly cross-origin) and produces much smaller, shareable files.
    RENDER.gif = (function () {
        const TARGET_BYTES = Math.floor(9.5 * 1024 * 1024);
        const state = { busy: false, token: 0 };

        class ByteWriter {
            constructor(capacity = 1024 * 1024) {
                this.buf = new Uint8Array(capacity);
                this.length = 0;
            }
            ensure(extra) {
                const need = this.length + extra;
                if (need <= this.buf.length) return;
                let size = this.buf.length;
                while (size < need) size *= 2;
                const next = new Uint8Array(size);
                next.set(this.buf);
                this.buf = next;
            }
            byte(value) {
                this.ensure(1);
                this.buf[this.length++] = value & 0xff;
            }
            u16(value) {
                this.byte(value);
                this.byte(value >> 8);
            }
            bytes(values) {
                this.ensure(values.length);
                this.buf.set(values, this.length);
                this.length += values.length;
            }
            ascii(value) {
                for (let i = 0; i < value.length; i++) this.byte(value.charCodeAt(i));
            }
            finish() { return this.buf.slice(0, this.length); }
        }

        function makePalette(mode) {
            const compact = mode === 'compact';
            const bits = compact ? 6 : 7;
            const tableSize = 1 << bits;
            const palette = new Uint8Array(tableSize * 3);
            const levels = [0, 85, 170, 255];
            // Index 0 is reserved for transparent pixels in delta frames.
            for (let ri = 0; ri < 4; ri++) {
                for (let gi = 0; gi < 4; gi++) {
                    const blueCount = compact ? 2 : 4;
                    for (let bi = 0; bi < blueCount; bi++) {
                        const index = compact
                            ? 1 + ri * 8 + gi * 2 + bi
                            : 1 + ri * 16 + gi * 4 + bi;
                        palette[index * 3] = levels[ri];
                        palette[index * 3 + 1] = levels[gi];
                        palette[index * 3 + 2] = compact ? (bi ? 255 : 0) : levels[bi];
                    }
                }
            }
            // Preserve the four Ingress faction colors exactly. They live in
            // otherwise unused slots beyond the RGB cube.
            const specialBase = compact ? 33 : 65;
            const specialColors = [
                [30, 144, 255], // RESISTANCE
                [50, 205, 50],  // ENLIGHTENED
                [158, 158, 158],// NEUTRAL
                [255, 23, 68]   // MACHINA
            ];
            const specialIndex = new Map();
            specialColors.forEach((rgb, offset) => {
                const index = specialBase + offset;
                palette[index * 3] = rgb[0];
                palette[index * 3 + 1] = rgb[1];
                palette[index * 3 + 2] = rgb[2];
                specialIndex.set((rgb[0] << 16) | (rgb[1] << 8) | rgb[2], index);
            });
            return {
                bits,
                palette,
                colorCount: compact ? 32 : 64,
                quantize(rgba) {
                    const count = rgba.length >> 2;
                    const out = new Uint8Array(count);
                    for (let src = 0, dst = 0; dst < count; src += 4, dst++) {
                        const exact = specialIndex.get((rgba[src] << 16) | (rgba[src + 1] << 8) | rgba[src + 2]);
                        if (exact !== undefined) {
                            out[dst] = exact;
                            continue;
                        }
                        const ri = Math.min(3, (rgba[src] + 42) / 85 | 0);
                        const gi = Math.min(3, (rgba[src + 1] + 42) / 85 | 0);
                        if (compact) {
                            const bi = rgba[src + 2] >= 128 ? 1 : 0;
                            out[dst] = 1 + ri * 8 + gi * 2 + bi;
                        } else {
                            const bi = Math.min(3, (rgba[src + 2] + 42) / 85 | 0);
                            out[dst] = 1 + ri * 16 + gi * 4 + bi;
                        }
                    }
                    return out;
                }
            };
        }

        function writeSubblockedLzw(writer, pixels, minCodeSize) {
            const clearCode = 1 << minCodeSize;
            const endCode = clearCode + 1;
            let nextCode = endCode + 1;
            let codeSize = minCodeSize + 1;
            let dictionary = new Map();
            const block = new Uint8Array(255);
            let blockLength = 0;
            let bitBuffer = 0;
            let bitCount = 0;

            const flushBlock = () => {
                if (!blockLength) return;
                writer.byte(blockLength);
                writer.bytes(block.subarray(0, blockLength));
                blockLength = 0;
            };
            const emitByte = (value) => {
                block[blockLength++] = value & 0xff;
                if (blockLength === 255) flushBlock();
            };
            const emitCode = (code) => {
                bitBuffer |= code << bitCount;
                bitCount += codeSize;
                while (bitCount >= 8) {
                    emitByte(bitBuffer & 0xff);
                    bitBuffer >>>= 8;
                    bitCount -= 8;
                }
            };
            const resetTable = () => {
                dictionary = new Map();
                nextCode = endCode + 1;
                codeSize = minCodeSize + 1;
            };

            writer.byte(minCodeSize);
            emitCode(clearCode);
            if (pixels.length) {
                let prefix = pixels[0];
                for (let i = 1; i < pixels.length; i++) {
                    const suffix = pixels[i];
                    const key = prefix * 256 + suffix;
                    const found = dictionary.get(key);
                    if (found !== undefined) {
                        prefix = found;
                        continue;
                    }

                    emitCode(prefix);
                    if (nextCode < 4096) {
                        dictionary.set(key, nextCode++);
                        // The decoder creates dictionary entries one emitted code
                        // behind the encoder. Grow only after crossing the limit;
                        // growing at equality corrupts large frames at 8→9 bits.
                        if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
                    } else {
                        emitCode(clearCode);
                        resetTable();
                    }
                    prefix = suffix;
                }
                emitCode(prefix);
            }
            emitCode(endCode);
            if (bitCount > 0) emitByte(bitBuffer & 0xff);
            flushBlock();
            writer.byte(0);
        }

        class GifEncoder {
            constructor(width, height, paletteSpec) {
                this.width = width;
                this.height = height;
                this.spec = paletteSpec;
                this.writer = new ByteWriter();
                this.previous = null;
                this.frameCount = 0;
                const w = this.writer;
                w.ascii('GIF89a');
                w.u16(width);
                w.u16(height);
                w.byte(0x80 | ((paletteSpec.bits - 1) << 4) | (paletteSpec.bits - 1));
                w.byte(1); // background index: actual black, not transparent index 0
                w.byte(0);
                w.bytes(paletteSpec.palette);
                // Infinite loop extension.
                w.bytes([0x21, 0xff, 0x0b]);
                w.ascii('NETSCAPE2.0');
                w.bytes([0x03, 0x01, 0x00, 0x00, 0x00]);
            }

            addFrame(indices, delayCs) {
                if (!(indices instanceof Uint8Array) || indices.length !== this.width * this.height) {
                    throw new Error('GIF frame has invalid dimensions');
                }
                let left = 0, top = 0, width = this.width, height = this.height;
                let pixels = indices;
                let transparent = false;

                if (this.previous) {
                    let minX = this.width, minY = this.height, maxX = -1, maxY = -1;
                    for (let i = 0; i < indices.length; i++) {
                        if (indices[i] === this.previous[i]) continue;
                        const x = i % this.width;
                        const y = (i / this.width) | 0;
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                    transparent = true;
                    if (maxX < 0) {
                        width = height = 1;
                        pixels = new Uint8Array(1);
                    } else {
                        left = minX;
                        top = minY;
                        width = maxX - minX + 1;
                        height = maxY - minY + 1;
                        pixels = new Uint8Array(width * height);
                        let dst = 0;
                        for (let y = minY; y <= maxY; y++) {
                            let src = y * this.width + minX;
                            for (let x = 0; x < width; x++, src++, dst++) {
                                pixels[dst] = indices[src] === this.previous[src] ? 0 : indices[src];
                            }
                        }
                    }
                }

                const w = this.writer;
                w.bytes([0x21, 0xf9, 0x04, transparent ? 0x05 : 0x04]);
                w.u16(Math.max(2, Math.min(65535, delayCs | 0)));
                w.byte(0); // transparent color index
                w.byte(0);
                w.byte(0x2c);
                w.u16(left);
                w.u16(top);
                w.u16(width);
                w.u16(height);
                w.byte(0);
                writeSubblockedLzw(w, pixels, this.spec.bits);
                this.previous = indices.slice();
                this.frameCount++;
            }

            finish() {
                this.writer.byte(0x3b);
                return this.writer.finish();
            }
        }

        function buildLinkLifecycles(startTs, endTs, selectedSet) {
            return LINK_LIFECYCLES.build(startTs, endTs, { selectedSet });
        }

        function makeProjection(points, width, height) {
            const padX = Math.round(width * 0.07);
            const padTop = Math.round(height * 0.15);
            const padBottom = Math.round(height * 0.09);
            let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
            for (const p of points) {
                if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lng)) continue;
                minLat = Math.min(minLat, p.lat);
                maxLat = Math.max(maxLat, p.lat);
                minLng = Math.min(minLng, p.lng);
                maxLng = Math.max(maxLng, p.lng);
            }
            if (!Number.isFinite(minLat)) throw new Error('No coordinates available for GIF export');
            const midLat = (minLat + maxLat) / 2;
            const cosLat = Math.max(0.15, Math.cos(midLat * Math.PI / 180));
            let spanX = Math.max(1e-5, (maxLng - minLng) * cosLat);
            let spanY = Math.max(1e-5, maxLat - minLat);
            const innerW = width - padX * 2;
            const innerH = height - padTop - padBottom;
            const scale = Math.min(innerW / spanX, innerH / spanY);
            const centerX = (minLng + maxLng) / 2;
            const centerY = (minLat + maxLat) / 2;
            return (p) => ({
                x: width / 2 + (p.lng - centerX) * cosLat * scale,
                y: padTop + innerH / 2 - (p.lat - centerY) * scale
            });
        }

        function captureMapViewport() {
            const map = window.map;
            if (!map?.getSize || !map?.getZoom || !map?.getPixelBounds || !map?.project) return null;
            try {
                const size = map.getSize();
                const pixelBounds = map.getPixelBounds();
                const zoom = map.getZoom();
                if (!(size?.x > 0) || !(size?.y > 0) || !pixelBounds?.min) return null;
                return {
                    sourceWidth: Number(size.x),
                    sourceHeight: Number(size.y),
                    zoom: Number(zoom),
                    minX: Number(pixelBounds.min.x),
                    minY: Number(pixelBounds.min.y),
                    // map.project(point, frozenZoom) is independent of later pan/zoom.
                    project(point) {
                        const pixel = map.project([point.lat, point.lng], zoom);
                        return { x: Number(pixel.x), y: Number(pixel.y) };
                    }
                };
            } catch (error) {
                console.warn('[trajectory-loader] unable to capture map viewport:', error);
                return null;
            }
        }

        function snapshotVisiblePortals(viewport) {
            if (!viewport || !window.portals || typeof window.portals !== 'object') return [];
            const result = [];
            for (const [guid, marker] of Object.entries(window.portals)) {
                try {
                    const latLng = marker?.getLatLng?.() || marker?._latlng;
                    const lat = Number(latLng?.lat);
                    const lng = Number(latLng?.lng);
                    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
                    const pixel = viewport.project({ lat, lng });
                    const x = pixel.x - viewport.minX;
                    const y = pixel.y - viewport.minY;
                    if (x < 0 || y < 0 || x > viewport.sourceWidth || y > viewport.sourceHeight) continue;

                    result.push({
                        guid,
                        lat,
                        lng
                    });
                } catch (error) {
                    // A partially loaded/removed Leaflet marker should not abort export.
                }
            }
            return result;
        }

        function captureMetricScale(viewport) {
            const map = window.map;
            if (!viewport || !map?.containerPointToLatLng || !map?.distance) return null;
            try {
                const maxWidth = Math.min(200, viewport.sourceWidth * 0.25);
                const y = viewport.sourceHeight / 2;
                const a = map.containerPointToLatLng([0, y]);
                const b = map.containerPointToLatLng([maxWidth, y]);
                const maxMeters = Number(map.distance(a, b));
                if (!(maxMeters > 0)) return null;
                const pow10 = Math.pow(10, String(Math.floor(maxMeters)).length - 1);
                const d = maxMeters / pow10;
                const factor = d >= 10 ? 10 : d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : 1;
                const meters = pow10 * factor;
                return {
                    meters,
                    label: meters < 1000 ? `${meters} m` : `${meters / 1000} km`,
                    sourcePixelWidth: Math.round(maxWidth * meters / maxMeters)
                };
            } catch (error) {
                console.warn('[trajectory-loader] unable to calculate scale bar:', error);
                return null;
            }
        }

        function getActiveBaseLayer() {
            const map = window.map;
            const records = window.layerChooser?._layers;
            if (!map || !Array.isArray(records)) return null;
            return records.find(record =>
                record && !record.overlay && record.layer && map.hasLayer?.(record.layer)
            ) || null;
        }

        function elementOpacity(element, stopAt) {
            let opacity = 1;
            for (let node = element; node && node !== stopAt?.parentElement; node = node.parentElement) {
                const style = window.getComputedStyle?.(node);
                if (!style || style.display === 'none' || style.visibility === 'hidden') return 0;
                const value = Number(style.opacity);
                if (Number.isFinite(value)) opacity *= value;
                if (node === stopAt) break;
            }
            return opacity;
        }

        function snapshotBasemapTiles(viewport) {
            if (!viewport || !window.map?.getContainer) return null;
            const mapContainer = window.map.getContainer();
            const mapRect = mapContainer.getBoundingClientRect();
            const active = getActiveBaseLayer();
            const layer = active?.layer || null;
            const root = layer?._container || window.map.getPane?.('tilePane') || mapContainer;
            const images = Array.from(root.querySelectorAll?.('img') || []);
            const tiles = [];
            for (const image of images) {
                const rect = image.getBoundingClientRect();
                if (!(rect.width > 0) || !(rect.height > 0) || !image.complete || !image.naturalWidth) continue;
                const left = rect.left - mapRect.left;
                const top = rect.top - mapRect.top;
                if (left >= viewport.sourceWidth || top >= viewport.sourceHeight ||
                    left + rect.width <= 0 || top + rect.height <= 0) continue;
                const opacity = elementOpacity(image, root);
                if (!(opacity > 0.001)) continue;
                const src = image.currentSrc || image.src;
                if (!src) continue;
                tiles.push({ src, left, top, width: rect.width, height: rect.height, opacity, element: image });
            }
            const mapStyle = window.getComputedStyle?.(mapContainer);
            const backgroundColor = layer?.options?.backgroundColor || mapStyle?.backgroundColor || '#000000';
            const attribution = String(
                layer?.getAttribution?.() || layer?._attributionText ||
                window.map.attributionControl?.getContainer?.()?.textContent || ''
            ).replace(/\s+/g, ' ').trim();
            return {
                name: String(active?.label || active?.name || 'active basemap'),
                tiles,
                backgroundColor,
                attribution
            };
        }

        function canReadImage(image) {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 1;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(image, 0, 0, 1, 1);
                ctx.getImageData(0, 0, 1, 1);
                return true;
            } catch (error) {
                return false;
            }
        }

        function loadReadableImage(tile) {
            let url;
            try { url = new URL(tile.src, window.location.href); } catch (error) { return Promise.resolve(null); }
            // Leaflet may already have loaded a cross-origin tile with CORS
            // enabled. Reuse it whenever it is canvas-readable, regardless of
            // URL origin; the one-pixel probe is isolated in a throwaway canvas.
            if (canReadImage(tile.element)) return Promise.resolve(tile.element);

            return new Promise(resolve => {
                const image = new Image();
                const timer = setTimeout(() => resolve(null), 10000);
                image.crossOrigin = 'anonymous';
                image.onload = () => {
                    clearTimeout(timer);
                    resolve(canReadImage(image) ? image : null);
                };
                image.onerror = () => { clearTimeout(timer); resolve(null); };
                image.src = tile.src;
            });
        }

        async function captureBasemapCanvas(model, token, onProgress) {
            const snapshot = model.basemapSnapshot;
            if (!model.viewport || !snapshot || !snapshot.tiles.length) {
                throw new Error('No readable basemap tiles are currently visible; disable Map or wait for the map to finish loading');
            }
            onProgress?.({ fraction: 0, message: `Capturing ${snapshot.tiles.length} visible map tiles...` });
            const loaded = await Promise.all(snapshot.tiles.map(loadReadableImage));
            if (token !== state.token) throw new DOMException('GIF export cancelled', 'AbortError');
            const successful = loaded.filter(Boolean).length;
            const failed = loaded.length - successful;
            if (failed) {
                throw new Error(`Basemap capture blocked by tile CORS (${successful}/${loaded.length} readable); switch basemap or disable Map`);
            }

            const width = Math.max(2, Math.round(model.viewport.sourceWidth));
            const height = Math.max(2, Math.round(model.viewport.sourceHeight));
            const { canvas, ctx } = makeCanvas(width, height);
            ctx.fillStyle = snapshot.backgroundColor || '#000000';
            ctx.fillRect(0, 0, width, height);
            for (let i = 0; i < snapshot.tiles.length; i++) {
                const image = loaded[i];
                if (!image) continue;
                const tile = snapshot.tiles[i];
                ctx.globalAlpha = Math.max(0, Math.min(1, tile.opacity));
                ctx.drawImage(image, tile.left, tile.top, tile.width, tile.height);
            }
            ctx.globalAlpha = 1;
            // Final taint check before this canvas is mixed into GIF frames.
            ctx.getImageData(0, 0, 1, 1);
            model.basemapCanvas = canvas;
            model.mapTileCount = successful;
            model.mapTileFailures = failed;
        }

        function makeExportGeometry(viewport, points, maxEdge) {
            if (!viewport) {
                return {
                    width: maxEdge,
                    height: maxEdge,
                    project: makeProjection(points, maxEdge, maxEdge),
                    usesMapViewport: false
                };
            }
            const ratio = maxEdge / Math.max(viewport.sourceWidth, viewport.sourceHeight);
            let width = Math.max(2, Math.round(viewport.sourceWidth * ratio));
            let height = Math.max(2, Math.round(viewport.sourceHeight * ratio));
            width -= width % 2;
            height -= height % 2;
            const scaleX = width / viewport.sourceWidth;
            const scaleY = height / viewport.sourceHeight;
            return {
                width,
                height,
                usesMapViewport: true,
                project(point) {
                    const pixel = viewport.project(point);
                    return {
                        x: (pixel.x - viewport.minX) * scaleX,
                        y: (pixel.y - viewport.minY) * scaleY
                    };
                }
            };
        }

        function normalizeTimeWindows(windows, fallbackStart, fallbackEnd) {
            const cleaned = (Array.isArray(windows) ? windows : [])
                .map(window => ({
                    startTs: Math.max(fallbackStart, Number(window?.startTs)),
                    endTs: Math.min(fallbackEnd, Number(window?.endTs))
                }))
                .filter(window => Number.isFinite(window.startTs) && Number.isFinite(window.endTs) && window.endTs > window.startTs)
                .sort((a, b) => a.startTs - b.startTs);
            if (!cleaned.length) return [{ startTs: fallbackStart, endTs: fallbackEnd }];
            const merged = [];
            for (const window of cleaned) {
                const previous = merged[merged.length - 1];
                if (previous && window.startTs <= previous.endTs + 1000) {
                    previous.endTs = Math.max(previous.endTs, window.endTs);
                } else {
                    merged.push({ ...window });
                }
            }
            return merged;
        }

        function buildFrameSchedule(windows, requestedFrameCount) {
            const count = windows.length;
            const frameCount = Math.max(requestedFrameCount, count * 2);
            const minimumFrames = count * 2;
            const remaining = frameCount - minimumFrames;
            const durations = windows.map(window => Math.max(1, window.endTs - window.startTs));
            const totalDuration = durations.reduce((sum, duration) => sum + duration, 0);
            const allocations = durations.map(duration => 2 + Math.floor(remaining * duration / totalDuration));
            let unassigned = frameCount - allocations.reduce((sum, value) => sum + value, 0);
            const remainderOrder = durations
                .map((duration, index) => ({
                    index,
                    remainder: remaining * duration / totalDuration - Math.floor(remaining * duration / totalDuration)
                }))
                .sort((a, b) => b.remainder - a.remainder);
            for (let i = 0; i < unassigned; i++) allocations[remainderOrder[i % count].index]++;

            const schedule = [];
            for (let windowIndex = 0; windowIndex < count; windowIndex++) {
                const window = windows[windowIndex];
                const frames = allocations[windowIndex];
                const frameStepMs = (window.endTs - window.startTs) / Math.max(1, frames - 1);
                for (let i = 0; i < frames; i++) {
                    schedule.push({
                        ts: window.startTs + frameStepMs * i,
                        windowIndex,
                        frameStepMs
                    });
                }
            }
            return schedule;
        }

        function collectModel(players, options = {}) {
            const selectedSet = new Set(players);
            const selectedEvents = (STORE.events || [])
                .filter(ev => selectedSet.has(ev.player) && getEventAnchor(ev))
                .sort((a, b) => a.ts - b.ts);
            if (!selectedEvents.length) throw new Error('The selected players have no spatial events');
            const fullStartTs = selectedEvents[0].ts;
            const fullEndTs = selectedEvents[selectedEvents.length - 1].ts;
            const timeWindows = normalizeTimeWindows(options.timeWindows, fullStartTs, fullEndTs);
            const startTs = timeWindows[0].startTs;
            const endTs = timeWindows[timeWindows.length - 1].endTs;
            const byPlayer = new Map();
            for (const player of players) {
                byPlayer.set(player, POSITION_MODEL.seriesForPlayer(player));
            }
            const links = buildLinkLifecycles(startTs, endTs, selectedSet);
            const points = selectedEvents
                .filter(ev => timeWindows.some(window => ev.ts >= window.startTs && ev.ts <= window.endTs))
                .map(getEventAnchor);
            for (const link of links) {
                if (!link.fromSnapshot) continue;
                points.push(link.a, link.b);
            }
            if (!points.length) {
                for (const ev of selectedEvents) points.push(getEventAnchor(ev));
            }
            const viewport = captureMapViewport();
            const layerOptions = {
                map: options.showMap === true,
                grid: options.showGrid !== false,
                portals: options.showPortals !== false,
                scale: options.showScale === true
            };
            const backgroundPortals = layerOptions.portals ? snapshotVisiblePortals(viewport) : [];
            const metricScale = layerOptions.scale ? captureMetricScale(viewport) : null;
            const basemapSnapshot = layerOptions.map ? snapshotBasemapTiles(viewport) : null;
            // Fit to operation sites, not remote link endpoints. Otherwise one
            // long link can shrink the actual trajectory to an unreadable dot;
            // links still render and are naturally clipped at the canvas edge.
            return {
                players, selectedSet, selectedEvents, byPlayer,
                links, points, startTs, endTs, timeWindows, viewport,
                layerOptions, backgroundPortals, metricScale, basemapSnapshot
            };
        }

        function drawLine(ctx, project, a, b) {
            const p1 = project(a), p2 = project(b);
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
        }

        function drawStaticBackground(ctx, model, project, width, height) {
            const scale = Math.max(width, height) / 720;
            ctx.globalAlpha = 1;
            ctx.setLineDash([]);
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, width, height);

            // Fixed background layer order: map < grid < portals.
            if (model.layerOptions.map && model.basemapCanvas) {
                ctx.drawImage(model.basemapCanvas, 0, 0, width, height);
            }

            if (model.layerOptions.grid) {
                ctx.strokeStyle = '#555555';
                ctx.globalAlpha = 0.75;
                ctx.lineWidth = Math.max(1.5, 1.5 * scale);
                const grid = Math.max(48, Math.round(width / 9));
                ctx.beginPath();
                for (let x = 0; x <= width; x += grid) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
                for (let y = 0; y <= height; y += grid) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
                ctx.stroke();
                ctx.globalAlpha = 1;
            }

            if (!model.layerOptions.portals) return;
            const portals = model.backgroundPortals || [];
            for (const portal of portals) {
                const point = project(portal);
                if (point.x < 0 || point.y < 0 || point.x > width || point.y > height) continue;
                // Portal background is intentionally faction-agnostic. It is a
                // uniform spatial reference, not a snapshot of portal state.
                const color = COLORS.TEAM_COLORS.NEUTRAL;
                const radius = Math.max(2, 2.6 * scale);
                ctx.fillStyle = '#000000';
                ctx.strokeStyle = color;
                ctx.lineWidth = Math.max(1, 1.35 * scale);
                ctx.beginPath();
                ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
        }

        function drawScaleOverlay(ctx, model, width, height) {
            if (!model.layerOptions.scale || !model.metricScale || !model.viewport) return;
            const scale = Math.max(width, height) / 720;
            const ratio = width / model.viewport.sourceWidth;
            const barWidth = Math.max(12, model.metricScale.sourcePixelWidth * ratio);
            const margin = 18 * scale;
            const tick = Math.max(4, 6 * scale);
            const lineWidth = Math.max(2, 2 * scale);
            const x2 = width - margin;
            const x1 = x2 - barWidth;
            const y = height - 45 * scale;

            ctx.save();
            ctx.globalAlpha = 1;
            ctx.font = `bold ${Math.max(10, Math.round(13 * scale))}px sans-serif`;
            ctx.textBaseline = 'bottom';
            ctx.textAlign = 'center';
            const labelWidth = ctx.measureText(model.metricScale.label).width;
            const panelX = Math.min(x1, (x1 + x2 - labelWidth) / 2) - 6 * scale;
            const panelWidth = Math.max(barWidth, labelWidth) + 12 * scale;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
            ctx.fillRect(panelX, y - 23 * scale, panelWidth, 31 * scale);
            ctx.strokeStyle = '#ffffff';
            ctx.fillStyle = '#ffffff';
            ctx.lineWidth = lineWidth;
            ctx.beginPath();
            ctx.moveTo(x1, y - tick);
            ctx.lineTo(x1, y);
            ctx.lineTo(x2, y);
            ctx.lineTo(x2, y - tick);
            ctx.stroke();
            ctx.fillText(model.metricScale.label, (x1 + x2) / 2, y - tick - 2 * scale);
            ctx.restore();
        }

        function drawFrame(ctx, model, project, ts, width, height, frameStepMs, backgroundCanvas, windowIndex) {
            const scale = Math.max(width, height) / 720;
            ctx.globalAlpha = 1;
            ctx.setLineDash([]);
            ctx.drawImage(backgroundCanvas, 0, 0);

            // Active links. Their color follows creator override > link faction;
            // the destroying player's override intentionally has no influence.
            ctx.lineWidth = Math.max(1.5, 2.4 * scale);
            for (const link of model.links) {
                if (ts < link.bornTs || ts >= link.deadTs) continue;
                ctx.strokeStyle = COLORS.resolveLink(link.createdBy, link.faction);
                ctx.globalAlpha = 1;
                drawLine(ctx, project, link.a, link.b);
            }

            // Recent event pulses.
            const recentMs = Math.max(60000, frameStepMs * 2.2);
            const activeWindow = model.timeWindows[windowIndex] || model.timeWindows[0];
            for (const ev of model.selectedEvents) {
                if (ev.ts > ts) break;
                if (ev.ts < ts - recentMs) continue;
                if (ev.ts < activeWindow.startTs || ev.ts > activeWindow.endTs) continue;
                const anchor = getEventAnchor(ev);
                const p = project(anchor);
                const age = Math.max(0, Math.min(1, (ts - ev.ts) / recentMs));
                ctx.strokeStyle = COLORS.resolve(ev.player, ev.team || null);
                ctx.globalAlpha = 0.85 * (1 - age);
                ctx.lineWidth = Math.max(1, 2 * scale);
                ctx.beginPath();
                ctx.arc(p.x, p.y, (7 + age * 12) * scale, 0, Math.PI * 2);
                ctx.stroke();
            }

            // Current player positions and legend.
            ctx.globalAlpha = 1;
            let legendY = 50 * scale;
            ctx.font = `${Math.max(11, Math.round(15 * scale))}px sans-serif`;
            ctx.textBaseline = 'middle';
            for (const player of model.players) {
                const series = model.byPlayer.get(player) || [];
                const pos = POSITION_MODEL.positionAt(series, ts);
                const team = STORE.playerIndex?.[player]?.team || null;
                const color = COLORS.resolve(player, team);
                if (pos) {
                    const p = project(pos);
                    ctx.fillStyle = color;
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = Math.max(1, 2 * scale);
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, Math.max(4, 6 * scale), 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                }
                ctx.fillStyle = color;
                ctx.fillRect(18 * scale, legendY - 5 * scale, 12 * scale, 10 * scale);
                ctx.fillStyle = '#ffffff';
                ctx.fillText(player, 38 * scale, legendY);
                legendY += 20 * scale;
            }

            ctx.fillStyle = '#ffffff';
            ctx.font = `bold ${Math.max(14, Math.round(20 * scale))}px sans-serif`;
            ctx.textBaseline = 'top';
            ctx.fillText('IITC Trajectory', 18 * scale, 15 * scale);
            ctx.font = `${Math.max(10, Math.round(14 * scale))}px monospace`;
            const stamp = formatDateTime(ts);
            const stampWidth = ctx.measureText(stamp).width;
            ctx.fillText(stamp, width - stampWidth - 18 * scale, 18 * scale);

            const progress = model.endTs > model.startTs
                ? (ts - model.startTs) / (model.endTs - model.startTs)
                : 1;
            const barX = 18 * scale, barY = height - 24 * scale;
            const barW = width - 36 * scale, barH = Math.max(4, 6 * scale);
            ctx.fillStyle = '#555555';
            ctx.fillRect(barX, barY, barW, barH);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(barX, barY, barW * Math.max(0, Math.min(1, progress)), barH);
            ctx.globalAlpha = 1;

            // Scale is deliberately last so it remains above every other layer.
            drawScaleOverlay(ctx, model, width, height);
        }

        function makeCanvas(width, height) {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
            if (!ctx) throw new Error('Canvas 2D is unavailable');
            return { canvas, ctx };
        }

        async function encodeAttempt(model, options, token, onProgress, attemptIndex, attemptCount) {
            const geometry = makeExportGeometry(model.viewport, model.points, options.size);
            const { canvas, ctx } = makeCanvas(geometry.width, geometry.height);
            const background = makeCanvas(geometry.width, geometry.height);
            const project = geometry.project;
            drawStaticBackground(background.ctx, model, project, geometry.width, geometry.height);
            const palette = makePalette(options.paletteMode);
            const encoder = new GifEncoder(geometry.width, geometry.height, palette);
            const requestedFrameCount = Math.max(2, Math.round(options.duration * options.fps));
            const schedule = buildFrameSchedule(model.timeWindows, requestedFrameCount);
            const frameCount = schedule.length;
            const delayCs = Math.max(2, Math.round(100 / options.fps));
            const endHoldCs = Math.round(options.endHoldSeconds * 100);

            for (let i = 0; i < frameCount; i++) {
                if (token !== state.token) throw new DOMException('GIF export cancelled', 'AbortError');
                const frame = schedule[i];
                drawFrame(ctx, model, project, frame.ts, geometry.width, geometry.height, frame.frameStepMs, background.canvas, frame.windowIndex);
                const rgba = ctx.getImageData(0, 0, geometry.width, geometry.height).data;
                encoder.addFrame(palette.quantize(rgba), delayCs + (i === frameCount - 1 ? endHoldCs : 0));
                if (i % 2 === 0 || i === frameCount - 1) {
                    onProgress?.({
                        fraction: (i + 1) / frameCount,
                        message: `Encoding ${options.size}px / ${options.fps} fps: ${i + 1}/${frameCount} (attempt ${attemptIndex + 1}/${attemptCount})`
                    });
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
            const bytes = encoder.finish();
            return {
                bytes, frameCount, paletteColors: palette.colorCount, options,
                width: geometry.width,
                height: geometry.height,
                usesMapViewport: geometry.usesMapViewport
            };
        }

        function buildAttempts(options) {
            const size = Math.max(384, Math.min(1920, Number(options.size) || 720));
            const fps = Math.max(3, Math.min(12, Number(options.fps) || 8));
            const duration = Math.max(5, Math.min(30, Number(options.duration) || 15));
            const endHoldSeconds = Math.max(1, Math.min(5, Math.round(Number(options.endHoldSeconds) || 3)));
            const raw = [
                { size: Math.round(size), fps: Math.round(fps), duration, endHoldSeconds, paletteMode: 'balanced' },
                { size: Math.max(480, Math.round(size * 0.83)), fps: Math.max(4, Math.round(fps * 0.75)), duration, endHoldSeconds, paletteMode: 'compact' },
                { size: Math.max(400, Math.round(size * 0.67)), fps: Math.max(3, Math.round(fps * 0.55)), duration, endHoldSeconds, paletteMode: 'compact' },
                { size: Math.max(400, Math.min(720, Math.round(size * 0.5))), fps: Math.max(3, Math.round(fps * 0.5)), duration: Math.min(duration, 15), endHoldSeconds, paletteMode: 'compact' },
                { size: 384, fps: 3, duration: Math.min(duration, 12), endHoldSeconds, paletteMode: 'compact' }
            ];
            const seen = new Set();
            return raw.filter(item => {
                item.size -= item.size % 2;
                const key = `${item.size}/${item.fps}/${item.duration}/${item.paletteMode}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        }

        function safeFilename(players) {
            const names = players.slice(0, 2).join('-').replace(/[\\/:*?\"<>|\s]+/g, '_').slice(0, 48) || 'players';
            const d = new Date();
            const pad = n => String(n).padStart(2, '0');
            return `trajectory-${names}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.gif`;
        }

        function download(bytes, filename) {
            const blob = new Blob([bytes], { type: 'image/gif' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        }

        async function exportGif(options = {}) {
            if (state.busy) throw new Error('A GIF export is already running');
            const players = Array.from(new Set((options.players || COLORS.selected).filter(Boolean)));
            if (!players.length) throw new Error('Select at least one player before exporting');
            const model = collectModel(players, options);
            const attempts = buildAttempts(options);
            const token = ++state.token;
            state.busy = true;
            try {
                if (model.layerOptions.map) {
                    await captureBasemapCanvas(model, token, options.onProgress);
                }
                let result = null;
                for (let i = 0; i < attempts.length; i++) {
                    options.onProgress?.({ fraction: 0, message: `Preparing GIF attempt ${i + 1}/${attempts.length}...` });
                    result = await encodeAttempt(model, attempts[i], token, options.onProgress, i, attempts.length);
                    if (result.bytes.length <= TARGET_BYTES || i === attempts.length - 1) break;
                    options.onProgress?.({
                        fraction: 1,
                        message: `${(result.bytes.length / 1048576).toFixed(1)} MB is too large; retrying with a smaller preset...`
                    });
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
                if (token !== state.token) throw new DOMException('GIF export cancelled', 'AbortError');
                const filename = safeFilename(players);
                download(result.bytes, filename);
                return {
                    filename,
                    byteLength: result.bytes.length,
                    frameCount: result.frameCount,
                    width: result.width,
                    height: result.height,
                    fps: result.options.fps,
                    duration: result.options.duration,
                    endHoldSeconds: result.options.endHoldSeconds,
                    totalDuration: result.options.duration + result.options.endHoldSeconds,
                    paletteColors: result.paletteColors,
                    usesMapViewport: result.usesMapViewport,
                    layers: { ...model.layerOptions },
                    portalCount: model.backgroundPortals.length,
                    linkCount: model.links.length,
                    snapshotLinkCount: model.links.filter(link => link.fromSnapshot).length,
                    mapTileCount: model.mapTileCount || 0,
                    mapTileFailures: model.mapTileFailures || 0,
                    timeWindows: model.timeWindows.map(window => ({ ...window })),
                    includedSourceDuration: model.timeWindows.reduce((sum, window) => sum + window.endTs - window.startTs, 0),
                    withinTarget: result.bytes.length <= TARGET_BYTES
                };
            } finally {
                if (token === state.token) state.busy = false;
            }
        }

        return {
            export: exportGif,
            cancel() {
                if (!state.busy) return false;
                state.token++;
                state.busy = false;
                return true;
            },
            get busy() { return state.busy; },
            // Kept deliberately small: useful for regression tests without Canvas/IITC.
            _test: {
                ByteWriter, GifEncoder, makePalette, writeSubblockedLzw,
                normalizeTimeWindows, buildFrameSchedule, buildLinkLifecycles
            }
        };
    })();


    // Render segments on map as clickable polylines with popups
    RENDER.renderSegments = function(segments) {
        // init layer group lazily
        if (!RENDER.state.layer) {
            RENDER.state.layer = new L.LayerGroup();
            RENDER.state.layer.addTo(window.map);
        } else {
            RENDER.state.layer.clearLayers();
        }

        const segsOut = [];

        for (const seg of segments) {
            const latlngs = [
                [seg.fromPt.lat, seg.fromPt.lng],
                [seg.toPt.lat, seg.toPt.lng]
            ];

            // style: optionally flag abnormal speed
            const overSpeed = (RENDER.config.maxSpeedKmh && seg.kmh > RENDER.config.maxSpeedKmh);
            const color = COLORS.resolve(seg.player, seg.team || seg.faction || null);
            const opts = {
                color: color,
                weight: RENDER.config.strokeWeight,
                opacity: overSpeed ? RENDER.config.doubtfulOpacity : RENDER.config.strokeOpacity,
                dashArray: RENDER.config.dashArray,
            };

            const pl = L.polyline(latlngs, opts);
            // clickable popup content
            const html =
                  `<div>Δt: ${formatDuration(seg.dtMs)}</div>` +
                  `<div>Distance: ${seg.dKm.toFixed(3)} km</div>` +
                  `<div> Min Speed: ${( isFinite(seg.kmh) && seg.kmh > 0 ) ? seg.kmh.toFixed(2) : '—'} km/h</div>`;

            pl.bindPopup(html, { maxWidth: 320, autoPan: false, closeButton: true });
            pl.addTo(RENDER.state.layer);

            // --- arrow head ---
            // Choose scale based on segment length (shorter line -> smaller arrow)
            const scale = Math.max(
                RENDER.config.arrowScaleMin,
                Math.min(RENDER.config.arrowScaleMax, seg.dKm * 1000 * 0.06) // ~6% of length, clamped
            );
            let arrow1 = null;
            let arrow2 = null;
            if (RENDER.config.segShowArrows) {
                const arrowLines = buildArrowHeadCoords(seg.fromPt, seg.toPt, scale, 28);
                const arrowOpts = {
                    color: color, // arrow color follows segment color
                    weight: RENDER.config.arrowWeight,
                    opacity: overSpeed ? RENDER.config.doubtfulOpacity : RENDER.config.arrowOpacity
                };
                arrow1 = L.polyline(arrowLines[0], arrowOpts).addTo(RENDER.state.layer);
                arrow2 = L.polyline(arrowLines[1], arrowOpts).addTo(RENDER.state.layer);
            }

            // Keep references for later highlight/clear
            seg.arrow1 = arrow1;
            seg.arrow2 = arrow2;

            seg.polyline = pl;
            segsOut.push(seg);
        }

        RENDER.state.segments = segsOut;
        return segsOut.length;
    };

    // Render segments for selected players within [now - past, now + future]
    RENDER.renderSegmentsWindowedForPlayers = function(playerNames) {
        const names = Array.isArray(playerNames) ? playerNames.filter(Boolean) : [];
        if (!names.length) {
            RENDER._windowRenderCache = null;
            if (RENDER.state.layer) RENDER.state.layer.clearLayers();
            RENDER.state.segments = [];
            return 0;
        }

        let now = RENDER.clock.now;
        const all = Array.isArray(STORE.events) ? STORE.events : [];
        let minTs = Infinity, maxTs = -Infinity;
        for (const ev of all) {
            if (names.includes(ev.player)) {
                if (ev.ts < minTs) minTs = ev.ts;
                if (ev.ts > maxTs) maxTs = ev.ts;
            }
        }
        if (!Number.isFinite(minTs) || !Number.isFinite(maxTs)) {
            RENDER._windowRenderCache = null;
            if (RENDER.state.layer) RENDER.state.layer.clearLayers();
            RENDER.state.segments = [];
            return 0;
        }
        // 夹紧到边界：末尾停在 maxTs，起始停在 minTs
        if (!Number.isFinite(now)) now = maxTs;
        if (now < minTs) now = minTs;
        if (now > maxTs) now = maxTs;

        const pastMs = RENDER.config.segWindowPastMs ?? 10*60*1000;
        const futureMs = RENDER.config.segWindowFutureMs ?? 0;
        const t0 = now - pastMs;
        const t1 = now + futureMs;

        // Cache the expensive full segment build while STORE.events and selection stay unchanged.
        const namesKey = Array.from(new Set(names)).sort().join('\u0000');
        let cache = RENDER._windowRenderCache;
        if (!cache || cache.events !== STORE.events || cache.namesKey !== namesKey) {
            cache = RENDER._windowRenderCache = {
                events: STORE.events,
                namesKey,
                allSegments: RENDER.buildSegmentsForPlayers(names),
                visibleKey: null
            };
        }

        let segs = cache.allSegments;
        // 仅显示“已结束”的线段：to.ts <= now；并限制在 [t0, now] 的时间窗内
        segs = segs.filter(s => {
            const a = s?.fromEv?.ts, b = s?.toEv?.ts;
            if (typeof a !== 'number' || typeof b !== 'number') return false;
            if (b <= now) return b >= t0;
            return futureMs > 0 && a <= t1;
        });

        // A 20 Hz clock should not clear/recreate Leaflet objects when membership
        // in the visible segment window has not changed.
        const first = segs[0];
        const last = segs[segs.length - 1];
        const visibleKey = [
            segs.length,
            first?.fromEv?.ts ?? '', first?.toEv?.ts ?? '',
            last?.fromEv?.ts ?? '', last?.toEv?.ts ?? ''
        ].join('|');
        if (cache.visibleKey === visibleKey) return RENDER.state.segments.length;
        cache.visibleKey = visibleKey;

        // 复用原有渲染器，但按配置禁用箭头（见 B2）
        const old = RENDER.config.segShowArrows;
        RENDER.config.segShowArrows = false;
        const n = RENDER.renderSegments(segs);
        RENDER.config.segShowArrows = old;
        return n;
    };

    // ----------------- SegmentsWindow (windowed segments driven by VClock) -----------------
    RENDER.segmentsWindow = (function () {
        const state = {
            players: [],     // 当前要渲染窗口段的玩家集合
            unsub: null,     // 退订函数
            rafLock: false,  // requestAnimationFrame 节流
        };

        function ensureSubscribed() {
            if (state.unsub) return;
            state.unsub = RENDER.clock.on((tPrev, tNow) => {
                if (!RENDER.config.showSegmentsInOverview) return;
                if (!state.players || state.players.length === 0) return;

                // 用 rAF 做 1 帧节流，避免 20Hz tick 过度清图重绘
                if (state.rafLock) return;
                state.rafLock = true;
                try {
                    requestAnimationFrame(() => {
                        state.rafLock = false;
                        try {
                            RENDER.renderSegmentsWindowedForPlayers(state.players);
                        } catch (e) {
                            console.warn('[trajectory-loader] windowed redraw failed:', e);
                        }
                    });
                } catch (e) {
                    // 在极少数无 rAF 环境退化为直接重绘
                    state.rafLock = false;
                    RENDER.renderSegmentsWindowedForPlayers(state.players);
                }
            });
        }

        return {
            get players() { return state.players.slice(); },
            setPlayers(list) {
                state.players = Array.isArray(list) ? list.filter(Boolean) : [];
                if (state.players.length) ensureSubscribed();
            },
            clear() {
                state.players = [];
                RENDER._windowRenderCache = null;
                // 不强制退订，使控制器常驻；完全销毁可在此调用 state.unsub?.()
            }
        };
    })();

    // ----------------- HaloController (windowed halos driven by VClock) -----------------
    RENDER.halos = (function () {
        const state = {
            layer: null,
            events: [],
            eventById: new Map(),
            now: null,
            live: new Map(),  // id -> { layer: L.Circle[]|L.Circle, removing?: boolean }
            unsub: null,
            timers: new Set(),
            perPlayer: new Map(), // player -> { forty: Event[], destroy: Event[] } (sorted by ts)
            links: new Map(), // lifecycle -> { a, b, faction, createdBy, destroyedBy, bornTs, deadTs, poly }
        };

        function ensureLayer() {
            if (!state.layer) {
                state.layer = new L.LayerGroup().addTo(window.map);
                try {
                    // 根据缩放刷新圈（重新构建当前窗口内的 halos）
                    window.map.on('zoomend', () => {
                        if (state.now != null) rebuildVisuals();
                    });
                } catch (e) {}
            }
        }

        // 事件唯一标识：ts + player + 首门户 guid/坐标 + type
        function eventId(ev) {
            const p = Array.isArray(ev.portals) && ev.portals[0];
            const g = p?.guid || `${p?.lat},${p?.lng}`;
            return `${ev.ts}|${ev.player || 'UNK'}|${ev.type}|${g || 'X'}`;
        }

        // Build a Leaflet circle as "uncertainty halo" for an event at its anchor.
        // 低缩放可见性：当 40m 在屏幕上的像素半径 < haloMinPixelRadius 时，使用 circleMarker 替代或隐藏。
        function buildUncertaintyHalo(ev) {
            const anchor = getEventAnchor(ev);
            if (!anchor) return null;
            const rMeters = RENDER.config.radiusByType?.[ev.type] ?? 40;
            const color = COLORS.resolve(ev.player, ev.team || ev.faction || null);

            // 若没有 map 或者未配置 min 像素阈值，则按米半径直接画
            const minPx = Number(RENDER.config.haloMinPixelRadius) || 0;
            if (!window.map || minPx <= 0) {
                return L.circle([anchor.lat, anchor.lng], {
                    radius: rMeters,
                    color,
                    weight: RENDER.config.haloStroke,
                    opacity: RENDER.config.haloOpacity,
                    dashArray: RENDER.config.haloDashArray,
                    fill: true,
                    fillOpacity: RENDER.config.haloFillOpacity
                });
            }

            // 估算当前缩放下，rMeters 对应的屏幕像素半径
            // 取锚点向东 rMeters 的点，算两点在屏幕坐标的距离
            try {
                const dest = destPoint(anchor.lat, anchor.lng, rMeters, 90); // 已有 helper
                const p0 = window.map.latLngToContainerPoint([anchor.lat, anchor.lng]);
                const p1 = window.map.latLngToContainerPoint([dest.lat, dest.lng]);
                const pxRadius = Math.hypot(p1.x - p0.x, p1.y - p0.y);

                if (pxRadius >= minPx) {
                    // 正常画米半径圆
                    return L.circle([anchor.lat, anchor.lng], {
                        radius: rMeters,
                        color,
                        weight: RENDER.config.haloStroke,
                        opacity: RENDER.config.haloOpacity,
                        dashArray: RENDER.config.haloDashArray,
                        fill: true,
                        fillOpacity: RENDER.config.haloFillOpacity
                    });
                } else {
                    // 低缩放处理：marker 或隐藏
                    if ((RENDER.config.haloLowZoomMode || 'marker') === 'marker') {
                        return L.circleMarker([anchor.lat, anchor.lng], {
                            radius: Math.max(4, Math.round(minPx * 0.5)), // 以阈值一半作为像素半径
                            color,
                            weight: RENDER.config.haloStroke,
                            opacity: RENDER.config.haloOpacity,
                            fill: true,
                            fillOpacity: RENDER.config.haloFillOpacity
                        });
                    } else {
                        return null; // 'hide'
                    }
                }
            } catch (e) {
                // 发生异常时回退为米半径圆
                return L.circle([anchor.lat, anchor.lng], {
                    radius: rMeters,
                    color,
                    weight: RENDER.config.haloStroke,
                    opacity: RENDER.config.haloOpacity,
                    dashArray: RENDER.config.haloDashArray,
                    fill: true,
                    fillOpacity: RENDER.config.haloFillOpacity
                });
            }
        }

        // 双端圈（弱提示，仅生命周期）：用于 link_destroyed，如果完全不想画，可让它返回 []
        function buildDualHalosForLink(ev) {
            const pts = Array.isArray(ev.portals) ? ev.portals.slice(0, 2) : [];
            if (pts.length < 2) return [];
            const r = (RENDER.config.radiusByType?.link_destroyed) ?? 168;
            const color = COLORS.resolve(ev.player, ev.team || ev.faction || null);
            return pts.map(p => L.circle([p.lat, p.lng], {
                radius: r,
                color,
                weight: (RENDER.config.haloStroke ?? 1.5),
                opacity: (RENDER.config.haloOpacity ?? 0.35),
                dashArray: (RENDER.config.haloDashArray ?? '4, 4'),
                fill: true,
                fillOpacity: (RENDER.config.haloFillOpacity ?? 0.12)
            }));
        }

        // --- geometry helpers for attack visualization ---
        // meters→lat/lng by bearing
        function _destByBearing(lat, lng, bearingDeg, distM) {
            const R = 6378137;
            const br = bearingDeg * Math.PI / 180;
            const dr = distM / R;
            const lat1 = lat * Math.PI / 180;
            const lng1 = lng * Math.PI / 180;
            const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(br));
            const lng2 = lng1 + Math.atan2(Math.sin(br) * Math.sin(dr) * Math.cos(lat1), Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2));
            return { lat: lat2 * 180 / Math.PI, lng: lng2 * 180 / Math.PI };
        }
        function _bearingDeg(from, to) {
            const φ1 = from.lat * Math.PI / 180, φ2 = to.lat * Math.PI / 180;
            const λ1 = from.lng * Math.PI / 180, λ2 = to.lng * Math.PI / 180;
            const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
            const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
            let θ = Math.atan2(y, x) * 180 / Math.PI;
            if (θ < 0) θ += 360;
            return θ; // [0,360)
        }
        function _angularDiff(a, b) {
            let d = Math.abs(a - b) % 360;
            return d > 180 ? 360 - d : d;
        }
        function _buildArcPoints(center, radiusM, startDeg, endDeg, steps) {
            // follow shortest direction from start to end
            let a1 = startDeg, a2 = endDeg;
            let diff = ((a2 - a1 + 540) % 360) - 180; // [-180,180]
            const N = Math.max(3, steps || 14);
            const pts = [];
            for (let i = 0; i <= N; i++) {
                const t = i / N;
                const ang = (a1 + diff * t + 360) % 360;
                pts.push(_destByBearing(center.lat, center.lng, ang, radiusM));
            }
            return pts;
        }

        function _addDestroyVisual(ev) {
            const p0 = Array.isArray(ev.portals) && ev.portals[0];
            if (!p0) return;
            ensureLayer();

            const col = COLORS.resolve(ev.player, ev.team || ev.faction || null);
            const layers = [];

            // 10m attack ring (mandatory)
            const ring = L.circle([p0.lat, p0.lng], {
                radius: RENDER.config.attackRingRadiusM || 10,
                color: col,
                weight: RENDER.config.attackRingStroke || 2,
                opacity: 0.85,
                fill: true,
                fillOpacity: 0.12
            }).addTo(state.layer);
            layers.push(ring);
            // one-shot pulse
            try {
                const r0 = ring.getRadius();
                const r1 = r0 * (RENDER.config.attackRingPulseScale || 1.2);
                ring.setRadius(r1);
                setTimeout(() => { try { ring.setRadius(r0); } catch {} }, RENDER.config.attackRingPulseMs || 260);
            } catch {}

            // directional arc + outward tick (optional)
            const who = ev.player || '__UNK__';
            const bucket = state.perPlayer.get(who) || { forty: [] };
            const center = { lat: p0.lat, lng: p0.lng };
            const t0 = ev.ts;

            // find prev/next 40m events by time (±attackWindow) OR distance (≤ attackSpatialThresholdM)
            const prev40 = (function () {
                const arr = bucket.forty || [];
                // last index with ts <= t0
                let lo = 0, hi = arr.length;
                while (lo < hi) { const mid = (lo + hi) >> 1; (arr[mid].ts <= t0) ? (lo = mid + 1) : (hi = mid); }
                for (let i = lo - 1; i >= 0; i--) {
                    const e = arr[i]; const a = Array.isArray(e.portals) ? e.portals[0] : null; if (!a) continue;
                    const dt = t0 - e.ts;
                    const dtOk = dt <= (RENDER.config.attackWindowPastMs || 10*60*1000);
                    let dOk = false;
                    try { dOk = window.map.distance([center.lat, center.lng], [a.lat, a.lng]) <= (RENDER.config.attackSpatialThresholdM || 250); } catch {}
                    if (dtOk || dOk) return { anchor: a, ts: e.ts };
                    if (!dtOk) break;
                }
                return null;
            })();
            const next40 = (function () {
                const arr = bucket.forty || [];
                // first index with ts > t0
                let lo = 0, hi = arr.length;
                while (lo < hi) { const mid = (lo + hi) >> 1; (arr[mid].ts <= t0) ? (lo = mid + 1) : (hi = mid); }
                for (let i = lo; i < arr.length; i++) {
                    const e = arr[i]; const a = Array.isArray(e.portals) ? e.portals[0] : null; if (!a) continue;
                    const dt = e.ts - t0;
                    const dtOk = dt <= (RENDER.config.attackWindowFutureMs || 10*60*1000);
                    let dOk = false;
                    try { dOk = window.map.distance([center.lat, center.lng], [a.lat, a.lng]) <= (RENDER.config.attackSpatialThresholdM || 250); } catch {}
                    if (dtOk || dOk) return { anchor: a, ts: e.ts };
                    if (!dtOk) break;
                }
                return null;
            })();

            if (prev40 || next40) {
                const radius = RENDER.config.attackWedgeRadiusM || 40;
                const tickLen = RENDER.config.attackTickLenM || 8;
                const minDeg = RENDER.config.attackWedgeMinDeg || 40;
                const maxDeg = RENDER.config.attackWedgeMaxDeg || 140;

                const θ1 = prev40 ? _bearingDeg(center, prev40.anchor) : null;
                const θ2 = next40 ? _bearingDeg(center, next40.anchor) : null;

                let startDeg, endDeg, midDeg;
                if (θ1 != null && θ2 != null) {
                    let d = ((θ2 - θ1 + 540) % 360) - 180; // [-180,180]
                    const span = Math.min(Math.max(Math.abs(d), minDeg), maxDeg);
                    const sign = d >= 0 ? 1 : -1;
                    startDeg = θ1;
                    endDeg   = (θ1 + sign * span + 360) % 360;
                    midDeg   = (θ1 + sign * (span / 2) + 360) % 360;
                } else {
                    const base = (θ1 != null ? θ1 : θ2);
                    const span = 90;
                    startDeg = (base - span/2 + 360) % 360;
                    endDeg   = (base + span/2 + 360) % 360;
                    midDeg   = base;
                }

                // arc (polyline)
                const arcPts = _buildArcPoints(center, radius, startDeg, endDeg, 14);
                const arc = L.polyline(arcPts, {
                    color: col,
                    weight: 2,
                    opacity: (RENDER.config.attackStrokeOpacity ?? 0.45)
                }).addTo(state.layer);
                layers.push(arc);

                // outward normal tick from arc midpoint
                const midPt = _destByBearing(center.lat, center.lng, midDeg, radius);
                const tipPt = _destByBearing(midPt.lat, midPt.lng, midDeg, tickLen);
                const tick = L.polyline([midPt, tipPt], {
                    color: col,
                    weight: (RENDER.config.attackTickWidth || 2),
                    opacity: (RENDER.config.attackStrokeOpacity ?? 0.45)
                }).addTo(state.layer);
                layers.push(tick);
            }

            return layers; // caller will register into state.live
        }

        function addEv(ev) {
            const id = eventId(ev);
            const existing = state.live.get(id);
            if (existing) {
                if (existing.removing && existing.timer) {
                    clearInterval(existing.timer);
                    state.timers.delete(existing.timer);
                    existing.timer = null;
                    existing.removing = false;
                    const arr = Array.isArray(existing.layer) ? existing.layer : [existing.layer];
                    for (const layer of arr) {
                        try { layer.setStyle({ opacity: RENDER.config.haloOpacity, fillOpacity: RENDER.config.haloFillOpacity }); } catch {}
                    }
                }
                return;
            }

            if (ev.type === 'destroy_reso') {
                const layers = _addDestroyVisual(ev); // returns L layers array (includes 10m ring)
                if (Array.isArray(layers) && layers.length) {
                    ensureLayer();
                    state.live.set(id, { layer: layers, lastTs: ev.ts });
                }
                return; // NOTE: do NOT draw any 168m halo for destroy
            }

            if (ev.type === 'link_destroyed') {
                // 你可以保留/弱化双端提示；或者直接 return 禁用
                // const halos = buildDualHalosForLink(ev); halos.forEach(h=>h.addTo(state.layer));
                return;
            }

            // default: draw 40m uncertainty halo for capture/deploy/link, as before
            const c = buildUncertaintyHalo(ev);
            if (c) {
                ensureLayer();
                c.addTo(state.layer);
                state.live.set(id, { layer: [c] });
            }
        }

        function fadeAndRemove(id, rec) {
            if (!rec || rec.removing) return;
            rec.removing = true;
            const steps = Math.max(1, RENDER.config.haloFadeSteps || 6);
            const interval = Math.round((RENDER.config.haloFadeDuration || 1200) / steps);
            let i = 0;
            const arr = Array.isArray(rec.layer) ? rec.layer : [rec.layer];
            const baseOp = (RENDER.config.haloOpacity ?? 0.35);
            const baseFill = (RENDER.config.haloFillOpacity ?? 0.12);
            const timer = setInterval(() => {
                i++;
                const f = 1 - i / steps;
                for (const l of arr) l.setStyle({ opacity: baseOp * f, fillOpacity: baseFill * f });
                if (i >= steps) {
                    clearInterval(timer);
                    state.timers.delete(timer);
                    for (const l of arr) l.remove();
                    state.live.delete(id);
                }
            }, interval);
            rec.timer = timer;
            state.timers.add(timer);
        }

        function cancelAnimations() {
            for (const timer of state.timers) clearInterval(timer);
            state.timers.clear();
            for (const rec of state.live.values()) {
                rec.timer = null;
                rec.removing = false;
            }
            for (const rec of state.links.values()) {
                rec.timer = null;
                rec.removing = false;
            }
        }

        function rebuildVisuals() {
            cancelAnimations();
            if (state.layer) state.layer.clearLayers();
            state.live.clear();
            for (const rec of state.links.values()) {
                rec.poly = null;
                rec.removing = false;
            }
            refreshWindow();
        }

        function refreshWindow() {
            if (state.now == null) return;
            const past = RENDER.config.haloWindowPastMs || 0;
            const future = RENDER.config.haloWindowFutureMs || 0;
            const start = state.now - past;
            const end = state.now + future;

            // 进入窗口：添加
            let lo = 0, hi = state.events.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (state.events[mid].ts < start) lo = mid + 1;
                else hi = mid;
            }
            for (let i = lo; i < state.events.length; i++) {
                const ev = state.events[i];
                if (ev.ts > end) break;
                addEv(ev);
            }

            // 离开窗口：淡出并移除
            for (const [id, rec] of Array.from(state.live.entries())) {
                // 通过 id 反查事件；规模较小时可接受，后续可加并行 map
                const ev = state.eventById.get(id);
                if (!ev || ev.ts < start || ev.ts > end) fadeAndRemove(id, rec);
            }

            // ----- Link lifecycle rendering -----
            const tNow = state.now;
            if (tNow != null) {
                // 显示：在 [bornTs, deadTs) 内的链
                for (const [key, rec] of state.links.entries()) {
                    if (rec.bornTs == null || rec.deadTs == null) continue;
                    const alive = (tNow >= rec.bornTs && tNow < rec.deadTs);
                    if (alive) {
                        if (rec.removing && rec.timer) {
                            clearInterval(rec.timer);
                            state.timers.delete(rec.timer);
                            rec.timer = null;
                            rec.removing = false;
                        }
                        if (!rec.poly) {
                            ensureLayer();
                            const color = COLORS.resolveLink(rec.createdBy, rec.faction || null);
                            rec.poly = L.polyline(
                                [[rec.a.lat, rec.a.lng], [rec.b.lat, rec.b.lng]],
                                { color, weight: RENDER.config.linkStroke || 3, opacity: RENDER.config.linkOpacity ?? 0.85 }
                            ).addTo(state.layer);
                        } else {
                            // keep visible (in case styles changed)
                            try { rec.poly.setStyle({ opacity: RENDER.config.linkOpacity ?? 0.85 }); } catch {}
                        }
                    } else {
                        // 不在存活区间（tNow < bornTs OR tNow >= deadTs）：统一淡出并移除
                        if (rec.poly && !rec.removing) {
                            rec.removing = true;
                            const steps = Math.max(1, RENDER.config.linkFadeSteps || 5);
                            const dt = Math.round((RENDER.config.linkFadeDuration || 800) / steps);
                            let i = 0;
                            const base = RENDER.config.linkOpacity ?? 0.85;
                            const timer = setInterval(() => {
                                i++;
                                const f = 1 - i / steps;
                                try { rec.poly.setStyle({ opacity: base * f }); } catch {}
                                if (i >= steps) {
                                    clearInterval(timer);
                                    state.timers.delete(timer);
                                    try { rec.poly.remove(); } catch {}
                                    rec.poly = null;
                                    rec.removing = false;
                                    rec.timer = null;
                                }
                            }, dt);
                            rec.timer = timer;
                            state.timers.add(timer);
                        }
                    }
                }
            }
        }

        function ensureSubscribed() {
            if (state.unsub) return;
            state.unsub = RENDER.clock.on((tPrev, tNow) => {
                state.now = tNow;
                refreshWindow();
            });
        }

        return {
            setEvents(arr) {
                state.events = Array.isArray(arr) ? arr.slice().sort((a, b) => a.ts - b.ts) : [];
                state.eventById = new Map(state.events.map(ev => [eventId(ev), ev]));

                // Build link lifecycle index
                cancelAnimations();
                for (const rec of state.links.values()) {
                    try { rec.poly?.remove(); } catch {}
                }
                state.links.clear();
                const startBound = RENDER.clock.startTs || (state.events[0]?.ts ?? 0);
                const endBound   = RENDER.clock.endTs   || (state.events[state.events.length-1]?.ts ?? startBound);

                const linkSource = (RENDER.config.linksFromAll ? (STORE.events || []) : state.events)
                    .slice()
                    .sort((a, b) => a.ts - b.ts);
                const lifecycles = LINK_LIFECYCLES.build(startBound, endBound, { events: linkSource });
                for (const lifecycle of lifecycles) {
                    state.links.set(lifecycle.id, {
                        ...lifecycle,
                        poly: null,
                        removing: false,
                        timer: null
                    });
                }

                // rebuild per-player indices for attack direction inference
                state.perPlayer.clear();
                for (const ev of state.events) {
                    const who = ev.player || '__UNK__';
                    let bucket = state.perPlayer.get(who);
                    if (!bucket) { bucket = { forty: [], destroy: [] }; state.perPlayer.set(who, bucket); }
                    if (ev.type === 'destroy_reso') bucket.destroy.push(ev);
                    else if (ev.type === 'capture' || ev.type === 'deploy' || ev.type === 'link') bucket.forty.push(ev);
                }
                // keep arrays sorted by ts (state.events 已整体升序；此处稳妥起见再排一次)
                for (const b of state.perPlayer.values()) {
                    b.forty.sort((a,b)=>a.ts-b.ts);
                    b.destroy.sort((a,b)=>a.ts-b.ts);
                }
                ensureSubscribed();
                // 不立即清 live：由 setNow/clock tick 来 reconcile
            },
            setNow(t) {
                state.now = Number(t);
                if (Number.isFinite(state.now)) refreshWindow();
            },
            clear() {
                cancelAnimations();
                if (state.layer) state.layer.clearLayers();
                state.live.clear();
                state.links.clear();
                state.perPlayer.clear();
                state.events = [];
                state.eventById.clear();
                state.now = null;
                // 不退订时钟，让控制器常驻；若要彻底销毁，可在此调用 state.unsub()
            },
            refresh() {
                if (state.now != null) rebuildVisuals();
            },
            getStats() {
                // NOTE: use closure 'state', not 'this'
                const totalEvents = Array.isArray(state.events) ? state.events.length : 0;
                const liveHalos = (state.live && typeof state.live.size === 'number') ? state.live.size : 0;
                const linkCycles = state.links.size;
                let liveLinks = 0;
                for (const rec of state.links.values()) if (rec.poly) liveLinks += 1;

                // current window bounds (based on state.now)
                const now = (typeof state.now === 'number') ? state.now : null;
                const past = (RENDER.config?.haloWindowPastMs ?? 0);
                const future = (RENDER.config?.haloWindowFutureMs ?? 0);
                const windowStart = (now != null) ? (now - past) : null;
                const windowEnd = (now != null) ? (now + future) : null;

                // current event index (1-based): number of events with ts <= now
                let currentIndex = 0;
                if (now != null && totalEvents > 0) {
                    // binary search upperBound on state.events (sorted by ts asc)
                    let lo = 0, hi = state.events.length;
                    while (lo < hi) {
                        const mid = (lo + hi) >> 1;
                        if (state.events[mid].ts <= now) lo = mid + 1; else hi = mid;
                    }
                    currentIndex = lo; // count of events <= now
                }

                return { totalEvents, liveHalos, linkCycles, liveLinks, windowStart, windowEnd, currentIndex };
            },
        };
    })();


    // Public API: show track for a player (build + render)
    RENDER.showForPlayer = function(playerName, options = {}) {
        if (!playerName) {
            console.warn('[trajectory-loader] showForPlayer: missing playerName');
            return 0;
        }
        // apply optional overrides
        if (options.maxSpeedKmh != null) RENDER.config.maxSpeedKmh = options.maxSpeedKmh;
        if (options.color) RENDER.config.strokeColor = options.color;
        if (options.weight) RENDER.config.strokeWeight = options.weight;

        let segCount = 0;
        if (RENDER.config.showSegmentsInOverview) {
            // 延后到 halos 与 now 就绪后，再统一调用 windowed 渲染
        } else {
            const segs = RENDER.buildSegmentsForPlayer(playerName);
            segCount = RENDER.renderSegments(segs);
        }

        // Add halos for this player's events
        const events = (STORE.events || []).filter(ev => ev.player === playerName);
        RENDER.state.activeEvents = events;
        // 同步时钟范围
        if (events.length) {
            RENDER.clock.setRange(events[0].ts, events[events.length - 1].ts);
        }
        RENDER.halos.clear();
        RENDER.halos.setEvents(events);

        let nowForWindow = RENDER.clock.now;
        if (typeof nowForWindow !== 'number' ||
            nowForWindow < (events[0]?.ts ?? -Infinity) ||
            nowForWindow > (events[events.length - 1]?.ts ?? Infinity)) {
            nowForWindow = events[0]?.ts ?? null;
        }
        if (nowForWindow != null) RENDER.halos.setNow(nowForWindow);

        if (RENDER.config.showSegmentsInOverview) {
            RENDER.renderSegmentsWindowedForPlayers([playerName]); // 首帧
            RENDER.segmentsWindow.setPlayers([playerName]);        // 驱动后续刷新
        } else {
            RENDER.segmentsWindow.clear();
        }

        console.log(`[trajectory-loader] follow(${playerName}): segments=${segCount}`);
        return segCount;
    };

    // Public API: show track for multiple players (build  render)
    RENDER.showForPlayers = function(playerNames, options = {}) {
        if (!Array.isArray(playerNames) || playerNames.length === 0) {
            console.warn('[trajectory-loader] showForPlayers: empty player list');
            return 0;
        }
        // apply optional overrides (same options as single-player)
        if (options.maxSpeedKmh != null) RENDER.config.maxSpeedKmh = options.maxSpeedKmh;
        if (options.color) RENDER.config.strokeColor = options.color;
        if (options.weight) RENDER.config.strokeWeight = options.weight;

        // init/clear layer
        if (!RENDER.state.layer) {
            RENDER.state.layer = new L.LayerGroup().addTo(window.map);
        } else {
            RENDER.state.layer.clearLayers();
        }
        // Optionally draw segments in overview (default off)
        let segCount = 0;
        if (RENDER.config.showSegmentsInOverview) {
            segCount = RENDER.renderSegmentsWindowedForPlayers(playerNames);
            RENDER.segmentsWindow.setPlayers(playerNames);
        } else {
            RENDER.state.segments = []; // keep empty for player-indexed UI
            RENDER.segmentsWindow.clear();
        }
        // 选中玩家的事件（按人过滤）
        const events = (STORE.events || []).filter(ev => playerNames.includes(ev.player));
        RENDER.state.activeEvents = events;
        // 同步时钟范围
        if (events.length) {
            RENDER.clock.setRange(events[0].ts, events[events.length - 1].ts);
        }
        // 将事件交给 HaloController，并把当前窗口时间设到合适位置
        RENDER.halos.clear();
        RENDER.halos.setEvents(events);

        // 选择窗口当前时刻：优先 clock.now（若有效），否则首事件时间
        let nowForWindow = RENDER.clock.now;
        if (typeof nowForWindow !== 'number' ||
            nowForWindow < (events[0]?.ts ?? -Infinity) ||
            nowForWindow > (events[events.length - 1]?.ts ?? Infinity)) {
            nowForWindow = events[0]?.ts ?? null;
        }
        if (nowForWindow != null) RENDER.halos.setNow(nowForWindow);

        console.log(`[trajectory-loader] overview: segments=${segCount}`);
        return segCount;
    };


    // Public API: clear current layer
    RENDER.clear = function() {
        if (RENDER.state.layer) RENDER.state.layer.clearLayers();
        RENDER.state.segments = [];
        RENDER.state.activeEvents = [];
        if (RENDER.halos && RENDER.halos.clear) RENDER.halos.clear();
        RENDER.segmentsWindow.clear();
        RENDER.clock.pause();
        RENDER.player?.stop?.();
    };

    RENDER.player = {
        timer: null,
        idx: -1,
        playing: false,
        intervalMs: 1200,
        // Playback parameters
        speedScale: 0.02,     // timeline(ms) -> wait(ms) multiplier. e.g. 0.02 = 50x speed
        minDelayMs: 250,      // lower bound per jump so UI feels responsive
        maxDelayMs: 5000,     // upper bound per jump to avoid "stuck for hours"

        highlight(index) {
            const segs = RENDER.state.segments;
            if (!segs || segs.length === 0) return;
            if (index < 0) index = 0;
            if (index >= segs.length) index = segs.length - 1;

            // reset styles
            for (const s of segs) {
                const color = COLORS.resolve(s.player, s.team || s.faction || null);
                if (s.polyline) s.polyline.setStyle({
                    color,
                    weight: RENDER.config.strokeWeight,
                    opacity: RENDER.config.strokeOpacity,
                    dashArray: '6,6'
                });
                if (s.arrow1) s.arrow1.setStyle({
                    color,
                    weight: RENDER.config.arrowWeight,
                    opacity: RENDER.config.arrowOpacity
                });
                if (s.arrow2) s.arrow2.setStyle({
                    color,
                    weight: RENDER.config.arrowWeight,
                    opacity: RENDER.config.arrowOpacity
                });
            }

            const curr = segs[index];
            if (!curr) return;
            // highlight current (purple solid line, thicker, full opacity)
            const hc = COLORS.resolve(curr.player, curr.team || curr.faction || null);
            curr.polyline?.setStyle({
                color: hc,
                weight: RENDER.config.strokeWeight,
                opacity: 1.0,
                dashArray: null                      // solid line
            });
            curr.arrow1?.setStyle({ color: hc, weight: RENDER.config.arrowWeight + 1, opacity: 1.0 });
            curr.arrow2?.setStyle({ color: hc, weight: RENDER.config.arrowWeight + 1, opacity: 1.0 });

            curr.polyline?.bringToFront();
            curr.arrow1?.bringToFront();
            curr.arrow2?.bringToFront();

            // open popup at mid point
            const midLat = (curr.fromPt.lat + curr.toPt.lat) / 2;
            const midLng = (curr.fromPt.lng + curr.toPt.lng) / 2;
            curr.polyline?.openPopup([midLat, midLng]);

            this.idx = index;

            this.idx = index;
            if (this.ui && (this.ui.slider || this.ui.label)) this.updateUI();
        },

        _advance() {
            const segs = RENDER.state.segments || [];
            if (!segs.length) return;
            const i = Math.min((this.idx ?? -1) + 1, segs.length - 1);
            this.highlight(i);
            const ts = segs[i]?.toEv?.ts;
            if (ts) RENDER.clock.seek(ts);
        },

        play() {
            // 1) 对齐时间轴范围（不主动改 now）
            const evs = (RENDER.state.activeEvents && RENDER.state.activeEvents.length)
                ? RENDER.state.activeEvents
                : (STORE.timeline?.events || []);
            if (!evs.length) return;
            RENDER.clock.setRange(evs[0].ts, evs[evs.length - 1].ts);

            const segs = RENDER.state.segments || [];

            // Helper：根据 now 选中段索引（优先“包含 now”的段，否则选“to<=now 的最后一段”，都没有则返回 0）
            function pickIndexByNow(nowTs) {
                if (!segs.length || typeof nowTs !== 'number') return -1;

                // ① containment：查找包含 now 的段
                for (let i = 0; i < segs.length; i++) {
                    const s = segs[i];
                    const a = s?.fromEv?.ts ?? -Infinity;
                    const b = s?.toEv?.ts ?? Infinity;
                    if (nowTs >= a && nowTs <= b) return i;
                }

                // ② before：二分“to<=now 的最后一段”
                let lo = 0, hi = segs.length - 1, ans = -1;
                while (lo <= hi) {
                    const mid = (lo + hi) >> 1;
                    const end = segs[mid]?.toEv?.ts ?? -Infinity;
                    if (end <= nowTs) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
                }
                if (ans >= 0) return ans;

                // ③ 全部在 now 之后：返回首段（即将到来的第一段）
                return 0;
            }

            // 2) 计算起播索引 & 时间
            const startBound = evs[0]?.ts;
            const endBound   = evs[evs.length - 1]?.ts;
            let now = RENDER.clock.now;

            // 若 now 非法/越界，才对齐到起点
            if (typeof now !== 'number' || now < startBound || now > endBound) {
                now = startBound;
                RENDER.clock.seek(now);
            }

            if (segs.length > 0) {
                // 根据 now 选择 idx，并高亮；不再强行对齐段边界
                const idx = pickIndexByNow(now);
                if (idx >= 0) this.highlight(idx);
                // 直接以当前 now 开始计时（bridge 会在 tick 中把 idx 保持同步）
                RENDER.clock.start();
                this.playing = true;
                return;
            }

            // 无 segments：保持当前 now，不强制回到开始（只在非法/越界时已对齐）
            RENDER.clock.start();
            this.playing = true;
        },

        // Internal: schedule advancing to next segment with time-proportional wait.
        // The wait is based on the idle gap between the current segment's end time
        // and the next segment's start time. If gap is zero (or negative), we fall
        // back to using the current segment's own duration (dtMs). Finally we clamp
        // with [minDelayMs, maxDelayMs] so the UI never appears "stuck".
        _scheduleNext() {
            if (!this.playing) return;

            const segs = RENDER.state.segments;
            if (!segs || segs.length === 0) return;

            // If this is the last segment, stop playback.
            if (this.idx + 1 >= segs.length) {
                return this.pause();
            }

            const curr = segs[this.idx];
            const next = segs[this.idx + 1];

            // Prefer the timeline "idle" gap between segments, because we skipped
            // same-portal events in rendering and must emulate waiting there.
            const gapMs = Math.max(0, (next.fromEv.ts - curr.toEv.ts));
            const waitMs = this.computeJumpDelayMs(gapMs, curr.dtMs);

            // Use setTimeout (variable delay) instead of setInterval (fixed delay).
            this.timer = setTimeout(() => {
                if (!this.playing) return;
                this._advance();           // advances idx and highlights
                this._scheduleNext();  // plan the following jump
            }, waitMs);
        },

        // Compute the actual wait time for the next jump.
        // base = (gapMs > 0 ? gapMs : segDtMs)  -> proportional wait
        // then clamp to [minDelayMs, maxDelayMs]
        computeJumpDelayMs(gapMs, segDtMs) {
            const base = (gapMs && gapMs > 0) ? gapMs : (segDtMs || 0);
            let wait = Math.round(base * this.speedScale);

            if (!isFinite(wait) || wait < this.minDelayMs) wait = this.minDelayMs;
            if (wait > this.maxDelayMs) wait = this.maxDelayMs;

            return wait;
        },

        pause() {
            this.playing = false;
            RENDER.clock.pause()
        },

        stop() {
            this.pause();
            this.idx = -1;
        },

        // --- UI bindings for quick seek ---
        ui: {
            slider: null, // <input type="range">
            label: null   // <span> like "12 / 87">
        },

        bindUI(slider, label) {
            this.ui = { slider, label };
            // initialize slider range by timeline
            const evs = STORE.timeline?.events || [];
            if (slider) {
                slider.disabled = !evs.length;
                if (!evs.length) {
                    slider.min = '0';
                    slider.max = '1';
                    slider.value = '0';
                }
            }
            if (slider && evs.length) {
                slider.min = String(evs[0].ts);
                slider.max = String(evs[evs.length - 1].ts);
                slider.step = '1000'; // 1s resolution; adjust as you like
                slider.value = String(RENDER.clock.now || evs[0].ts);
                slider.oninput = () => {
                    const ts = Number(slider.value);
                    RENDER.clock.seek(ts);
                    // update immediately for snappy UX
                    this.updateUI?.();
                };
            }

            this.updateUI?.(); // initial sync
        },

        // Update slider min/max/value and label text from current segments & idx
        updateUI() {
            const label = this.ui?.label;
            const slider = this.ui?.slider;
            const hasTimeline = (STORE.timeline?.events || []).length > 0;

            if (!hasTimeline) {
                if (label) label.textContent = '0 / 0';
                return;
            }

            const now = RENDER.clock.now;
            if (slider && typeof now === 'number') {
                slider.value = String(now); // keep slider synced to virtual time (ms)
            }

            // Fallback time text
            const timeText = (typeof now === 'number') ? formatDateTime(now) : '—';

            // Pull event stats from halo controller
            let totalEv = 0, currentEv = 0;
            try {
                if (RENDER.halos && typeof RENDER.halos.getStats === 'function') {
                    const st = RENDER.halos.getStats();
                    totalEv = st?.totalEvents || 0;
                    currentEv = st?.currentIndex || 0; // 1-based position
                }
            } catch (_) { /* ignore */ }

            if (!label) return;
            // Only show "eventPos / totalEvents [time]"
            label.textContent = `${currentEv} / ${totalEv} [${timeText}]`;
        },

        // Jump to a specific segment index and highlight it
        seek(index) {
            const segs = RENDER.state.segments || [];
            if (segs.length === 0) return;

            let idx = Number(index);
            if (!Number.isFinite(idx)) idx = 0;
            if (idx < 0) idx = 0;
            if (idx >= segs.length) idx = segs.length - 1;

            this.highlight(idx);   // will set this.idx inside
            this.updateUI();
        },

        setSpeed(x) {
            const v = RENDER.clock.setSpeed(x);
            console.log('[trajectory-loader] speed x' + v);
        }

    };

    // Bridge: advance segment index by virtual time
    RENDER.player._clockUnsub = RENDER.player._clockUnsub || RENDER.clock.on((tPrev, tNow) => {
        const segs = RENDER.state.segments || [];
        if (!segs.length) { if (RENDER.player.ui) RENDER.player.updateUI?.(); return; }
        // find current segment by time: prefer the one whose [from.ts, to.ts] contains tNow,
        // otherwise pick the last whose end time <= tNow
        // Binary search from scratch so arbitrary backward seeks are correct.
        let lo = 0, hi = segs.length - 1, idx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const end = segs[mid]?.toEv?.ts ?? -Infinity;
            if (end <= tNow) { idx = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        if (idx < 0) {
            const firstStart = segs[0]?.fromEv?.ts ?? Infinity;
            if (tNow >= firstStart) idx = 0;
        }
        if (idx < 0) {
            RENDER.player.idx = -1;
            RENDER.player.updateUI?.();
            return;
        }
        if (idx !== RENDER.player.idx) {
            RENDER.player.highlight(idx);
        } else {
            // even if index unchanged, keep UI time label/slider in sync
            RENDER.player.updateUI?.();
        }
    });


    RENDER.setColor = function (hex) {
        // Basic guard
        if (typeof hex !== 'string' || !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) {
            console.warn('[trajectory-loader] setColor: invalid color:', hex);
            return;
        }
        RENDER.config.strokeColor = hex;

        // The renderer uses the unified player palette. Apply the requested
        // global color to the currently active players so this API is effective.
        const activePlayers = new Set((RENDER.state.activeEvents || []).map(ev => ev.player).filter(Boolean));
        for (const playerName of activePlayers) COLORS.setOverride(playerName, hex);

        // Restyle existing layer without rebuilding segments
        const segs = RENDER.state.segments || [];
        for (const s of segs) {
            const c = COLORS.resolve(s.player, s.team || s.faction || null);
            if (s.polyline) s.polyline.setStyle({ color: c });
            if (s.arrow1) s.arrow1.setStyle({ color: c });
            if (s.arrow2) s.arrow2.setStyle({ color: c });
        }

        // Re-apply highlight styling for the current segment, if any
        if (RENDER.player && RENDER.player.idx >= 0) {
            RENDER.player.highlight(RENDER.player.idx);
        }
        RENDER.halos?.refresh?.();
        console.log('[trajectory-loader] track color set to', hex);
    };

    // Set or clear a specific player's color override.
    // Usage: setPlayerColor('Alice', '#ff8800');  // set
    //        setPlayerColor('Alice', null);       // clear override
    RENDER.setPlayerColor = function (playerName, hex) {
        if (!playerName || typeof playerName !== 'string') {
            console.warn('[trajectory-loader] setPlayerColor: invalid playerName:', playerName);
            return;
        }
        if (hex == null) {
            COLORS.resetOverride(playerName);
        } else {
            if (typeof hex !== 'string' || !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) {
                console.warn('[trajectory-loader] setPlayerColor: invalid color:', hex);
                return;
            }
            COLORS.setOverride(playerName, hex);
        }

        // Restyle existing segments/arrows in place
        const segs = RENDER.state.segments || [];
        for (const s of segs) {
            if (s.player !== playerName) continue;
            const c = COLORS.resolve(s.player, s.team || s.faction || null);
            if (s.polyline) s.polyline.setStyle({ color: c });
            if (s.arrow1)  s.arrow1.setStyle({  color: c });
            if (s.arrow2)  s.arrow2.setStyle({  color: c });
        }

        // Keep highlight visuals coherent
        if (RENDER.player && RENDER.player.idx >= 0) {
            RENDER.player.highlight(RENDER.player.idx);
        }
        RENDER.halos?.refresh?.();
        console.log('[trajectory-loader] player color updated:', playerName, hex);
    };


    // ---------- UI ----------
    UI.open = function openDialog() {
        if (UI._open) return;

        // ─────────────────────────────────────────────────────────────
        // Root container
        // ─────────────────────────────────────────────────────────────
        const container = document.createElement('div');
        container.style.width = '100%';
        container.style.minWidth = '0';
        container.style.maxWidth = '680px';
        container.style.boxSizing = 'border-box';

        // ─────────────────────────────────────────────────────────────
        // Section 1: File loader (label + input + inline Load button)
        // ─────────────────────────────────────────────────────────────
        const fileSection = document.createElement('div');

        const fileLabel = document.createElement('div');
        fileLabel.textContent = 'Data';
        fileLabel.style.fontWeight = 'bold';
        fileLabel.style.marginBottom = '6px';

        const fileRow = document.createElement('div');
        fileRow.style.display = 'flex';
        fileRow.style.flexDirection = 'column';
        fileRow.style.alignItems = 'flex-start';
        fileRow.style.gap = '6px';

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.multiple = true;
        fileInput.accept = 'application/json';
        fileInput.style.width = '100%';
        fileInput.style.maxWidth = '100%';
        fileInput.style.minWidth = '0';
        fileInput.style.boxSizing = 'border-box';

        const btnLoadInline = document.createElement('button');
        btnLoadInline.textContent = 'Load File';
        btnLoadInline.style.height = '28px';
        btnLoadInline.style.flex = '0 0 auto';

        fileSection.appendChild(fileLabel);
        fileRow.appendChild(fileInput);
        fileRow.appendChild(btnLoadInline);
        fileSection.appendChild(fileRow);

        const snapshotRow = document.createElement('div');
        snapshotRow.style.display = 'flex';
        snapshotRow.style.flexDirection = 'column';
        snapshotRow.style.alignItems = 'flex-start';
        snapshotRow.style.gap = '6px';
        snapshotRow.style.marginTop = '10px';

        const snapshotLabel = document.createElement('div');
        snapshotLabel.textContent = 'Link snapshot (optional)';
        snapshotLabel.style.fontSize = '12px';

        const snapshotInput = document.createElement('input');
        snapshotInput.type = 'file';
        snapshotInput.accept = 'application/json';
        snapshotInput.style.width = '100%';
        snapshotInput.style.maxWidth = '100%';
        snapshotInput.style.minWidth = '0';
        snapshotInput.style.boxSizing = 'border-box';

        const snapshotActions = document.createElement('div');
        snapshotActions.style.display = 'flex';
        snapshotActions.style.flexWrap = 'wrap';
        snapshotActions.style.gap = '6px';
        const btnLoadSnapshot = document.createElement('button');
        btnLoadSnapshot.textContent = 'Load Snapshot';
        btnLoadSnapshot.style.height = '28px';
        const btnClearSnapshot = document.createElement('button');
        btnClearSnapshot.textContent = 'Remove Snapshot';
        btnClearSnapshot.style.height = '28px';
        btnClearSnapshot.style.display = STORE.snapshot ? '' : 'none';
        snapshotActions.appendChild(btnLoadSnapshot);
        snapshotActions.appendChild(btnClearSnapshot);

        const snapshotSummary = document.createElement('div');
        snapshotSummary.style.fontSize = '12px';
        snapshotSummary.style.opacity = '0.9';
        snapshotSummary.style.overflowWrap = 'anywhere';
        snapshotRow.appendChild(snapshotLabel);
        snapshotRow.appendChild(snapshotInput);
        snapshotRow.appendChild(snapshotActions);
        snapshotRow.appendChild(snapshotSummary);
        fileSection.appendChild(snapshotRow);


        // ─────────────────────────────────────────────────────────────
        // Section 2: Players & Colors (multi-select + per-player color)
        // ─────────────────────────────────────────────────────────────
        const playersSection = document.createElement('div');
        playersSection.style.marginTop = '12px';

        const playersLabel = document.createElement('div');
        playersLabel.textContent = 'Players';
        playersLabel.style.marginBottom = '6px';
        playersLabel.style.fontWeight = 'bold';
        playersSection.appendChild(playersLabel);

        // Scrollable list container
        const playersList = document.createElement('div');
        playersList.style.maxHeight = '200px';
        playersList.style.overflow = 'auto';
        playersList.style.border = '1px solid rgba(0,0,0,0.2)';
        playersList.style.padding = '6px';
        playersList.style.width = '100%';
        playersList.style.boxSizing = 'border-box';
        playersSection.appendChild(playersList);

        // Utility: build the list from STORE.playerIndex
        function rebuildPlayersList() {
            playersList.innerHTML = '';
            const names = STORE.playerIndex ? Object.keys(STORE.playerIndex) : [];
            // sort by activity (desc) if stats are present
            names.sort((a, b) => {
                const ia = STORE.playerIndex?.[a]?.count || 0;
                const ib = STORE.playerIndex?.[b]?.count || 0;
                return ib - ia;
            });
            // Drop persisted selections that do not exist in the newly loaded log.
            if (Array.isArray(STORE.events)) {
                const available = new Set(names);
                COLORS.setSelected(COLORS.selected.filter(name => available.has(name)));
            }
            for (const name of names) {
                const row = document.createElement('div');
                row.style.display = 'flex';
                row.style.alignItems = 'center';
                row.style.gap = '8px';
                row.style.margin = '4px 0';
                row.style.minWidth = '0';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.value = name;
                cb.checked = COLORS.isSelected(name);
                cb.style.transform = 'scale(1.1)';
                cb.style.flex = '0 0 auto';
                cb.addEventListener('change', () => {
                    if (cb.checked) COLORS.addSelected(name);
                    else COLORS.removeSelected(name);
                });

                const label = document.createElement('span');
                label.textContent = name;
                label.style.flex = '1 1 auto';
                label.style.minWidth = '0';
                label.style.overflow = 'hidden';
                label.style.textOverflow = 'ellipsis';
                label.style.whiteSpace = 'nowrap';

                const color = document.createElement('input');
                color.type = 'color';
                color.style.flex = '0 0 auto';
                color.value = /^#[0-9a-f]{6}$/i.test(COLORS.overrides[name] || '')
                    ? COLORS.overrides[name]
                    : '#000000';
                color.oninput = () => {
                    COLORS.setOverride(name, color.value);
                    refreshColors();
                    if (activityPlayers.includes(name)) drawActivityTimeline();
                };

                row.appendChild(cb);
                row.appendChild(label);
                row.appendChild(color);
                playersList.appendChild(row);
            }
        }
        rebuildPlayersList();

        // Track display options
        const chkFollow = document.createElement('input');
        chkFollow.type = 'checkbox';
        chkFollow.checked = true;
        const lblFollow = document.createElement('span');
        lblFollow.textContent = 'Full trail (single player)';
        const chkSegs = document.createElement('input');
        chkSegs.type = 'checkbox';
        chkSegs.checked = true;
        const lblSegs = document.createElement('span');
        lblSegs.textContent = 'Short trails (multiple players)';

        const trackOptions = document.createElement('div');
        trackOptions.style.marginTop = '8px';
        trackOptions.style.display = 'flex';
        trackOptions.style.flexWrap = 'wrap';
        trackOptions.style.alignItems = 'center';
        trackOptions.style.gap = '6px 16px';
        const singleCheck = document.createElement('label');
        singleCheck.style.display = 'inline-flex';
        singleCheck.style.alignItems = 'center';
        singleCheck.style.gap = '4px';
        singleCheck.appendChild(chkFollow);
        singleCheck.appendChild(lblFollow);
        const multiCheck = document.createElement('label');
        multiCheck.style.display = 'inline-flex';
        multiCheck.style.alignItems = 'center';
        multiCheck.style.gap = '4px';
        multiCheck.appendChild(chkSegs);
        multiCheck.appendChild(lblSegs);
        trackOptions.appendChild(singleCheck);
        trackOptions.appendChild(multiCheck);
        playersSection.appendChild(trackOptions);

        // Section 3: Summary (numbers) + Progress log (pre)
        // ─────────────────────────────────────────────────────────────
        const summary = document.createElement('div');
        summary.style.marginTop = '6px';
        summary.style.fontSize = '12px';
        summary.style.opacity = '0.9';

        const logDetails = document.createElement('details');
        logDetails.style.marginTop = '6px';
        const logToggle = document.createElement('summary');
        logToggle.textContent = 'Load log';
        logToggle.style.cursor = 'pointer';
        logToggle.style.fontSize = '12px';
        logToggle.style.opacity = '0.8';

        const pre = document.createElement('pre');
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.maxHeight = '140px';
        pre.style.overflowY = 'auto';
        pre.style.margin = '6px 0 0';
        pre.style.padding = '6px';
        pre.style.background = 'rgba(0,0,0,0.12)';
        pre.textContent = '';
        logDetails.appendChild(logToggle);
        logDetails.appendChild(pre);

        function setSummary(res) {
            if (!res) { summary.textContent = ''; return; }
            const { timeStart, timeEnd, playersTotal, spatialEvents } = res;
            const fileWord = STORE.stats.fileCount === 1 ? 'file' : 'files';
            summary.textContent = `${STORE.stats.fileCount} ${fileWord} · ${spatialEvents ?? 0} events · ${playersTotal} players · ${formatTs(timeStart)} – ${formatTs(timeEnd)}`;
        }

        function setSnapshotSummary(error = null) {
            if (error) {
                snapshotSummary.textContent = `Snapshot failed: ${error}`;
                return;
            }
            const snapshot = STORE.snapshot;
            btnClearSnapshot.style.display = snapshot ? '' : 'none';
            if (!snapshot) {
                snapshotSummary.textContent = '';
                return;
            }
            const skipped = snapshot.skippedLinks ? ` · ${snapshot.skippedLinks} skipped` : '';
            const duplicates = snapshot.duplicateLinks ? ` · ${snapshot.duplicateLinks} duplicate endpoints` : '';
            const merge = snapshot.lastMergeStats;
            const merged = merge
                ? ` · ${merge.visible} active snapshot links${merge.conflicts ? ` · ${merge.conflicts} conflicts` : ''}`
                : '';
            snapshotSummary.textContent = `${snapshot.name} · ${formatTs(snapshot.capturedAtMs)} · ` +
                `${snapshot.links.length}/${snapshot.sourceCounts.links} links${skipped}${duplicates}${merged}`;
        }
        setSnapshotSummary();

        btnLoadSnapshot.onclick = async () => {
            const file = snapshotInput.files?.[0];
            if (!file) {
                setSnapshotSummary('Choose a snapshot JSON file.');
                return;
            }
            btnLoadSnapshot.disabled = true;
            snapshotSummary.textContent = 'Loading snapshot…';
            try {
                await loadSnapshotFile(file);
                if (RENDER.state.activeEvents?.length) btnRender.click();
                setSnapshotSummary();
            } catch (error) {
                setSnapshotSummary(error?.message || error);
            } finally {
                btnLoadSnapshot.disabled = false;
            }
        };

        btnClearSnapshot.onclick = () => {
            SNAPSHOT.clear();
            snapshotInput.value = '';
            if (RENDER.state.activeEvents?.length) btnRender.click();
            setSnapshotSummary();
        };

        // Wire up inline loader
        btnLoadInline.onclick = async () => {
            const files = Array.from(fileInput.files || []);
            if (files.length === 0) {
                summary.textContent = 'Choose one or more COMM JSON files.';
                return;
            }
            btnLoadInline.disabled = true;
            summary.textContent = 'Loading…';
            pre.textContent = '';
            try {
                const res = await loadAndMerge(files, (msg) => {
                    pre.textContent += msg + '\n';
                    pre.scrollTop = pre.scrollHeight;
                });
                setSummary(res);
                clearActivityTimeline();
                rebuildPlayersList(); // keep player list in sync
                window.plugin.trajectoryLoader.render.player.bindUI(seekSlider, seekLabel);
            } catch (e) {
                summary.textContent = `Load failed: ${e.message}`;
                pre.textContent += `Error: ${e.message}\n`;
                logDetails.open = true;
            } finally {
                btnLoadInline.disabled = false;
            }
        };

        // ─────────────────────────────────────────────────────────────
        // Section 4: Playback controls ( Play / Pause )
        // ─────────────────────────────────────────────────────────────
        const playbackTitle = document.createElement('div');
        playbackTitle.textContent = 'Playback';
        playbackTitle.style.marginTop = '12px';
        playbackTitle.style.paddingTop = '10px';
        playbackTitle.style.borderTop = '1px solid rgba(0,0,0,0.2)';
        playbackTitle.style.fontWeight = 'bold';

        const playbackRow = document.createElement('div');
        playbackRow.style.marginTop = '6px';
        playbackRow.style.display = 'flex';
        playbackRow.style.flexWrap = 'wrap';
        playbackRow.style.gap = '6px';

        const btnPlay = document.createElement('button');
        btnPlay.textContent = 'Play';
        btnPlay.style.height = '28px';
        btnPlay.onclick = () => window.plugin.trajectoryLoader.render.player.play();

        const btnPause = document.createElement('button');
        btnPause.textContent = 'Pause';
        btnPause.style.height = '28px';
        btnPause.onclick = () => window.plugin.trajectoryLoader.render.player.pause();

        // Action buttons: render & clear

        const btnRender = document.createElement('button');
        btnRender.textContent = 'Render';
        btnRender.style.height = '28px';
        btnRender.onclick = () => {
            // gather checked players
            const boxes = Array.from(playersList.querySelectorAll('input[type="checkbox"]'));
            const selected = boxes.filter(box => box.checked).map(box => box.value);
            COLORS.setSelected(selected);
            if (selected.length === 0) {
                console.warn('[trajectory-loader] no players selected');
                return;
            }
            const fullSingleTrack = chkFollow.checked && selected.length === 1;
            RENDER.config.showSegmentsInOverview = fullSingleTrack ? false : !!chkSegs.checked;
            if (fullSingleTrack) {
                plugin?.trajectoryLoader?.render?.showForPlayer?.(selected[0], {});
            } else {
                plugin?.trajectoryLoader?.render?.showForPlayers?.(selected, {});
            }
            // enable player UI slider/label if present
            if (RENDER && RENDER.player && RENDER.player.updateUI) RENDER.player.updateUI();
            resetGifWindows();
            drawActivityTimeline(selected);
            setSnapshotSummary();
        };

        const btnClear = document.createElement('button');
        btnClear.textContent = 'Clear';
        btnClear.style.height = '28px';
        btnClear.onclick = () => {
            plugin.trajectoryLoader.render.clear();
            if (RENDER && RENDER.player) RENDER.player.stop?.();
            clearActivityTimeline();
        };

        const renderActions = document.createElement('div');
        renderActions.style.display = 'flex';
        renderActions.style.gap = '6px';
        renderActions.appendChild(btnRender);
        renderActions.appendChild(btnClear);
        const transportActions = document.createElement('div');
        transportActions.style.display = 'flex';
        transportActions.style.gap = '6px';
        transportActions.appendChild(btnPlay);
        transportActions.appendChild(btnPause);
        playbackRow.appendChild(renderActions);
        playbackRow.appendChild(transportActions);

        // ─────────────────────────────────────────────────────────────
        // Section 4.5: Speed presets (1× / 10× / 25× / 50× / 100×)
        // ─────────────────────────────────────────────────────────────
        const speedRow = document.createElement('div');
        speedRow.style.marginTop = '6px';
        speedRow.style.display = 'flex';
        speedRow.style.flexWrap = 'wrap';
        speedRow.style.alignItems = 'center';
        speedRow.style.gap = '4px';

        const speedLabel = document.createElement('span');
        speedLabel.textContent = 'Speed:';
        speedLabel.style.display = 'inline-block';
        speedLabel.style.marginRight = '2px';
        speedRow.appendChild(speedLabel);

        const presetVals = (RENDER.config.speedPresets || [1,10,25,50,100]).slice();
        const speedSelect = document.createElement('select');
        speedSelect.style.height = '26px';
        for (const v of presetVals) {
            const option = document.createElement('option');
            option.value = String(v);
            option.textContent = `${v}×`;
            speedSelect.appendChild(option);
        }
        speedRow.appendChild(speedSelect);

        function _applySpeed(v) {
            const ok = window.plugin.trajectoryLoader.render.clock.setSpeed(v);
            speedSelect.value = String(ok);
            try { localStorage.setItem('trajectoryLoader.speed', String(ok)); } catch {}
        }
        speedSelect.onchange = () => _applySpeed(Number(speedSelect.value));

        // 初始化：从 localStorage 恢复；否则按 defaultSpeedIndex
        let initV = null;
        try {
            const saved = Number(localStorage.getItem('trajectoryLoader.speed'));
            if (isFinite(saved) && saved >= 1) initV = saved;
        } catch {}

        if (!initV) {
            const idx = Math.max(0, Math.min((RENDER.config.defaultSpeedIndex|0), presetVals.length - 1));
            initV = presetVals[idx];
        }
        _applySpeed(initV);

        // ─────────────────────────────────────────────────────────────
        // Section 5: Quick seek (label + range slider)
        // ─────────────────────────────────────────────────────────────
        const seekRow = document.createElement('div');
        seekRow.style.marginTop = '8px';
        seekRow.style.display = 'flex';
        seekRow.style.flexDirection = 'column';
        seekRow.style.alignItems = 'stretch';
        seekRow.style.gap = '4px';

        const seekLabel = document.createElement('span');
        seekLabel.textContent = '0 / 0';
        seekLabel.style.display = 'inline-block';
        seekLabel.style.minWidth = '72px';

        const seekSlider = document.createElement('input');
        seekSlider.type = 'range';
        seekSlider.style.width = '100%';
        seekSlider.style.boxSizing = 'border-box';

        const activityCanvas = document.createElement('canvas');
        activityCanvas.style.display = 'none';
        activityCanvas.style.width = '100%';
        activityCanvas.style.boxSizing = 'border-box';
        activityCanvas.style.borderRadius = '2px';
        activityCanvas.setAttribute('aria-label', 'Player activity timeline');

        const windowControls = document.createElement('div');
        windowControls.style.display = 'none';
        windowControls.style.alignItems = 'center';
        windowControls.style.flexWrap = 'wrap';
        windowControls.style.gap = '4px 6px';
        const windowStatus = document.createElement('span');
        windowStatus.style.flex = '1 1 180px';
        windowStatus.style.fontSize = '12px';
        const btnRemoveWindow = document.createElement('button');
        btnRemoveWindow.textContent = 'Remove';
        btnRemoveWindow.style.height = '24px';
        const btnClearWindows = document.createElement('button');
        btnClearWindows.textContent = 'Clear all';
        btnClearWindows.style.height = '24px';
        windowControls.appendChild(windowStatus);
        windowControls.appendChild(btnRemoveWindow);
        windowControls.appendChild(btnClearWindows);

        const selectionCanvas = document.createElement('canvas');
        selectionCanvas.style.display = 'none';
        selectionCanvas.style.width = '100%';
        selectionCanvas.style.height = '24px';
        selectionCanvas.style.boxSizing = 'border-box';
        selectionCanvas.style.borderRadius = '2px';
        selectionCanvas.style.cursor = 'crosshair';
        selectionCanvas.style.touchAction = 'none';
        selectionCanvas.setAttribute('aria-label', 'GIF time window selector');
        selectionCanvas.title = 'Drag to add a GIF time window';

        const ACTIVITY_TYPES = new Set(['capture', 'deploy', 'destroy_reso', 'link', 'link_destroyed']);
        let activityPlayers = [];
        let activityDrawFrame = 0;
        let gifWindows = [];
        let selectedWindowIndex = -1;
        let windowDrag = null;

        function timelineBounds() {
            const startTs = Number(RENDER.clock.startTs);
            const endTs = Number(RENDER.clock.endTs);
            return Number.isFinite(startTs) && Number.isFinite(endTs) && endTs > startTs
                ? { startTs, endTs }
                : null;
        }

        function normalizeGifWindows(windows) {
            const bounds = timelineBounds();
            if (!bounds) return [];
            const cleaned = windows
                .map(item => ({
                    startTs: Math.max(bounds.startTs, Math.min(item.startTs, item.endTs)),
                    endTs: Math.min(bounds.endTs, Math.max(item.startTs, item.endTs))
                }))
                .filter(item => item.endTs - item.startTs >= 1000)
                .sort((a, b) => a.startTs - b.startTs);
            const merged = [];
            for (const item of cleaned) {
                const previous = merged[merged.length - 1];
                if (previous && item.startTs <= previous.endTs + 1000) {
                    previous.endTs = Math.max(previous.endTs, item.endTs);
                } else {
                    merged.push({ ...item });
                }
            }
            return merged;
        }

        function compactTime(ts) {
            const d = new Date(ts);
            const pad = value => String(value).padStart(2, '0');
            return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        }

        function updateWindowControls() {
            const available = activityPlayers.length > 0 && !!timelineBounds();
            windowControls.style.display = available ? 'flex' : 'none';
            selectionCanvas.style.display = available ? 'block' : 'none';
            if (!available || !gifWindows.length) {
                windowStatus.textContent = 'GIF windows: drag to add';
                btnRemoveWindow.style.display = 'none';
                btnClearWindows.style.display = 'none';
                return;
            }
            selectedWindowIndex = Math.max(0, Math.min(selectedWindowIndex, gifWindows.length - 1));
            const selected = gifWindows[selectedWindowIndex];
            windowStatus.textContent = `${selectedWindowIndex + 1}/${gifWindows.length} · ${compactTime(selected.startTs)}–${compactTime(selected.endTs)}`;
            btnRemoveWindow.style.display = '';
            btnClearWindows.style.display = '';
        }

        function resetGifWindows() {
            gifWindows = [];
            selectedWindowIndex = -1;
            windowDrag = null;
            updateWindowControls();
            drawSelectionRail();
        }

        function selectionXForTime(ts, width, bounds) {
            return (ts - bounds.startTs) / (bounds.endTs - bounds.startTs) * width;
        }

        function selectionTimeForPointer(event) {
            const bounds = timelineBounds();
            const rect = selectionCanvas.getBoundingClientRect();
            if (!bounds || !(rect.width > 0)) return null;
            const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
            return bounds.startTs + ratio * (bounds.endTs - bounds.startTs);
        }

        function currentDraftWindow() {
            if (!windowDrag) return null;
            if (windowDrag.mode === 'create') {
                return {
                    startTs: Math.min(windowDrag.startTs, windowDrag.currentTs),
                    endTs: Math.max(windowDrag.startTs, windowDrag.currentTs)
                };
            }
            return gifWindows[windowDrag.index] || null;
        }

        function paintWindows(ctx, width, height, bounds, includeLabels) {
            const windows = gifWindows.map((item, index) => ({ ...item, index, draft: false }));
            const draft = currentDraftWindow();
            if (draft && windowDrag?.mode === 'create') windows.push({ ...draft, index: -1, draft: true });
            for (const item of windows) {
                const x1 = selectionXForTime(item.startTs, width, bounds);
                const x2 = selectionXForTime(item.endTs, width, bounds);
                const selected = !item.draft && item.index === selectedWindowIndex;
                ctx.fillStyle = item.draft
                    ? 'rgba(255,255,255,0.16)'
                    : selected ? 'rgba(255,255,255,0.26)' : 'rgba(255,255,255,0.14)';
                ctx.fillRect(x1, 0, Math.max(1, x2 - x1), height);
                ctx.strokeStyle = selected || item.draft ? '#ffffff' : 'rgba(255,255,255,0.65)';
                ctx.lineWidth = selected ? 2 : 1;
                ctx.strokeRect(x1 + 0.5, 0.5, Math.max(1, x2 - x1 - 1), Math.max(1, height - 1));
                if (selected) {
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(x1 - 1, 0, 3, height);
                    ctx.fillRect(x2 - 2, 0, 3, height);
                }
                if (includeLabels && !item.draft && x2 - x1 >= 18) {
                    ctx.fillStyle = '#ffffff';
                    ctx.font = 'bold 10px sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(String(item.index + 1), (x1 + x2) / 2, height / 2);
                }
            }
        }

        function drawSelectionRail() {
            updateWindowControls();
            if (selectionCanvas.style.display === 'none') return;
            const bounds = timelineBounds();
            const width = Math.max(1, Math.floor(selectionCanvas.getBoundingClientRect().width));
            const height = 24;
            const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
            selectionCanvas.width = Math.max(1, Math.round(width * pixelRatio));
            selectionCanvas.height = Math.max(1, Math.round(height * pixelRatio));
            const ctx = selectionCanvas.getContext('2d');
            if (!ctx || !bounds) return;
            ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
            ctx.fillStyle = 'rgba(255,255,255,0.08)';
            ctx.fillRect(0, 0, width, height);
            paintWindows(ctx, width, height, bounds, true);
        }

        function redrawWindowSelection() {
            drawSelectionRail();
            if (activityPlayers.length) drawActivityTimeline();
        }

        function windowHitAtPointer(event) {
            const bounds = timelineBounds();
            const rect = selectionCanvas.getBoundingClientRect();
            if (!bounds || !(rect.width > 0)) return null;
            const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
            const edgeTolerance = 7;
            for (let index = gifWindows.length - 1; index >= 0; index--) {
                const item = gifWindows[index];
                const x1 = selectionXForTime(item.startTs, rect.width, bounds);
                const x2 = selectionXForTime(item.endTs, rect.width, bounds);
                if (Math.abs(x - x1) <= edgeTolerance) return { index, edge: 'start' };
                if (Math.abs(x - x2) <= edgeTolerance) return { index, edge: 'end' };
                if (x > x1 && x < x2) return { index, edge: null };
            }
            return null;
        }

        selectionCanvas.onpointerdown = event => {
            const ts = selectionTimeForPointer(event);
            if (ts == null) return;
            event.preventDefault();
            const hit = windowHitAtPointer(event);
            if (hit) {
                selectedWindowIndex = hit.index;
                if (hit.edge) {
                    windowDrag = {
                        mode: hit.edge === 'start' ? 'resize-start' : 'resize-end',
                        index: hit.index,
                        originalWindows: gifWindows.map(item => ({ ...item }))
                    };
                    selectionCanvas.setPointerCapture?.(event.pointerId);
                }
                redrawWindowSelection();
                return;
            }
            selectedWindowIndex = -1;
            windowDrag = { mode: 'create', startTs: ts, currentTs: ts, startX: event.clientX };
            selectionCanvas.setPointerCapture?.(event.pointerId);
            redrawWindowSelection();
        };

        selectionCanvas.onpointermove = event => {
            if (!windowDrag) {
                const hit = windowHitAtPointer(event);
                selectionCanvas.style.cursor = hit?.edge ? 'ew-resize' : 'crosshair';
                return;
            }
            const ts = selectionTimeForPointer(event);
            if (ts == null) return;
            if (windowDrag.mode === 'create') {
                windowDrag.currentTs = ts;
            } else {
                const item = gifWindows[windowDrag.index];
                const bounds = timelineBounds();
                if (!item || !bounds) return;
                if (windowDrag.mode === 'resize-start') {
                    item.startTs = Math.max(bounds.startTs, Math.min(ts, item.endTs - 1000));
                } else {
                    item.endTs = Math.min(bounds.endTs, Math.max(ts, item.startTs + 1000));
                }
            }
            redrawWindowSelection();
        };

        selectionCanvas.onpointerup = event => {
            if (!windowDrag) return;
            const drag = windowDrag;
            const ts = selectionTimeForPointer(event);
            if (drag.mode === 'create' && ts != null && Math.abs(event.clientX - drag.startX) >= 3) {
                const midpoint = (drag.startTs + ts) / 2;
                gifWindows = normalizeGifWindows([
                    ...gifWindows,
                    { startTs: Math.min(drag.startTs, ts), endTs: Math.max(drag.startTs, ts) }
                ]);
                selectedWindowIndex = gifWindows.findIndex(item => midpoint >= item.startTs && midpoint <= item.endTs);
            } else if (drag.mode !== 'create') {
                const item = gifWindows[drag.index];
                const midpoint = item ? (item.startTs + item.endTs) / 2 : NaN;
                gifWindows = normalizeGifWindows(gifWindows);
                selectedWindowIndex = gifWindows.findIndex(window => midpoint >= window.startTs && midpoint <= window.endTs);
            }
            windowDrag = null;
            selectionCanvas.releasePointerCapture?.(event.pointerId);
            redrawWindowSelection();
        };

        selectionCanvas.onpointercancel = event => {
            if (windowDrag?.originalWindows) gifWindows = windowDrag.originalWindows;
            windowDrag = null;
            selectionCanvas.releasePointerCapture?.(event.pointerId);
            redrawWindowSelection();
        };

        btnRemoveWindow.onclick = () => {
            if (selectedWindowIndex < 0 || selectedWindowIndex >= gifWindows.length) return;
            gifWindows.splice(selectedWindowIndex, 1);
            selectedWindowIndex = Math.min(selectedWindowIndex, gifWindows.length - 1);
            redrawWindowSelection();
        };

        btnClearWindows.onclick = () => {
            gifWindows = [];
            selectedWindowIndex = -1;
            windowDrag = null;
            redrawWindowSelection();
        };

        function clearActivityTimeline() {
            activityPlayers = [];
            if (activityDrawFrame) cancelAnimationFrame(activityDrawFrame);
            activityDrawFrame = 0;
            activityCanvas.style.display = 'none';
            activityCanvas.width = 1;
            activityCanvas.height = 1;
            resetGifWindows();
        }

        function drawActivityTimeline(players = activityPlayers) {
            activityPlayers = Array.from(new Set((players || []).filter(Boolean)));
            const selected = new Set(activityPlayers);
            const events = (STORE.events || []).filter(ev =>
                selected.has(ev.player) && ACTIVITY_TYPES.has(ev.type) && Number.isFinite(ev.ts)
            );
            if (!activityPlayers.length || !events.length) {
                clearActivityTimeline();
                return;
            }

            activityCanvas.style.display = 'block';
            if (activityDrawFrame) cancelAnimationFrame(activityDrawFrame);
            activityDrawFrame = requestAnimationFrame(() => {
                activityDrawFrame = 0;
                const width = Math.max(1, Math.floor(activityCanvas.getBoundingClientRect().width));
                const laneHeight = 6;
                const laneGap = 2;
                const padding = 2;
                const height = padding * 2 + activityPlayers.length * laneHeight +
                    Math.max(0, activityPlayers.length - 1) * laneGap;
                const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
                activityCanvas.style.height = `${height}px`;
                activityCanvas.width = Math.max(1, Math.round(width * pixelRatio));
                activityCanvas.height = Math.max(1, Math.round(height * pixelRatio));
                const ctx = activityCanvas.getContext('2d');
                if (!ctx) return;
                ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
                ctx.clearRect(0, 0, width, height);
                ctx.fillStyle = 'rgba(255,255,255,0.06)';
                ctx.fillRect(0, 0, width, height);

                let startTs = Number(RENDER.clock.startTs);
                let endTs = Number(RENDER.clock.endTs);
                if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) {
                    startTs = events[0].ts;
                    endTs = events[events.length - 1].ts;
                }
                const span = Math.max(1, endTs - startTs);
                const binCount = Math.max(1, Math.floor(width / 3));

                for (let lane = 0; lane < activityPlayers.length; lane++) {
                    const player = activityPlayers[lane];
                    const playerEvents = events.filter(ev => ev.player === player);
                    const sample = playerEvents[0];
                    const color = COLORS.resolve(player, sample?.team || STORE.playerIndex?.[player]?.team || null);
                    const y = padding + lane * (laneHeight + laneGap);
                    ctx.globalAlpha = 0.18;
                    ctx.fillStyle = color;
                    ctx.fillRect(0, y, width, laneHeight);

                    const bins = new Uint16Array(binCount);
                    let maxCount = 0;
                    for (const ev of playerEvents) {
                        const ratio = Math.max(0, Math.min(1, (ev.ts - startTs) / span));
                        const index = Math.min(binCount - 1, Math.floor(ratio * binCount));
                        const count = ++bins[index];
                        if (count > maxCount) maxCount = count;
                    }
                    const binWidth = width / binCount;
                    for (let i = 0; i < binCount; i++) {
                        if (!bins[i]) continue;
                        ctx.globalAlpha = 0.35 + 0.65 * Math.log1p(bins[i]) / Math.log1p(maxCount);
                        ctx.fillStyle = color;
                        ctx.fillRect(i * binWidth, y, Math.max(1, Math.ceil(binWidth)), laneHeight);
                    }
                }
                ctx.globalAlpha = 1;
                const bounds = { startTs, endTs };
                paintWindows(ctx, width, height, bounds, false);
                drawSelectionRail();
            });
        }

        const activityResizeObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(() => {
                if (activityPlayers.length) drawActivityTimeline();
            })
            : null;
        activityResizeObserver?.observe(seekRow);

        window.plugin.trajectoryLoader.render.player.bindUI(seekSlider, seekLabel);

        seekRow.appendChild(seekLabel);
        seekRow.appendChild(activityCanvas);
        seekRow.appendChild(windowControls);
        seekRow.appendChild(selectionCanvas);
        seekRow.appendChild(seekSlider);

        // ─────────────────────────────────────────────────────────────
        // Section 6: compact GIF export
        // ─────────────────────────────────────────────────────────────
        const gifSection = document.createElement('div');
        gifSection.style.marginTop = '12px';
        gifSection.style.paddingTop = '10px';
        gifSection.style.borderTop = '1px solid rgba(0,0,0,0.2)';

        const gifTitle = document.createElement('div');
        gifTitle.textContent = 'GIF export';
        gifTitle.style.fontWeight = 'bold';
        gifTitle.style.marginBottom = '6px';
        gifSection.appendChild(gifTitle);

        const gifOptions = document.createElement('div');
        gifOptions.style.display = 'flex';
        gifOptions.style.flexWrap = 'wrap';
        gifOptions.style.gap = '8px';
        gifOptions.style.alignItems = 'center';

        function addGifSelect(labelText, values, initial) {
            const label = document.createElement('label');
            label.textContent = `${labelText}: `;
            label.style.display = 'inline-flex';
            label.style.alignItems = 'center';
            label.style.gap = '3px';
            const select = document.createElement('select');
            for (const [value, text] of values) {
                const option = document.createElement('option');
                option.value = String(value);
                option.textContent = text;
                option.selected = String(value) === String(initial);
                select.appendChild(option);
            }
            label.appendChild(select);
            gifOptions.appendChild(label);
            return select;
        }

        function addGifCheckbox(labelText, checked) {
            const label = document.createElement('label');
            label.style.display = 'inline-flex';
            label.style.alignItems = 'center';
            label.style.gap = '3px';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = checked;
            label.appendChild(input);
            label.appendChild(document.createTextNode(labelText));
            gifOptions.appendChild(label);
            return input;
        }

        const gifSize = addGifSelect('Size', [[1920, '1080p'], [720, '720 px'], [640, '640 px'], [512, '512 px']], 720);
        const gifFps = addGifSelect('FPS', [[8, '8'], [6, '6'], [4, '4']], 8);
        const gifDuration = addGifSelect('Duration', [[10, '10 s'], [15, '15 s'], [20, '20 s']], 15);
        const gifEndHold = addGifSelect('End hold', [[1, '1 s'], [2, '2 s'], [3, '3 s'], [4, '4 s'], [5, '5 s']], 3);
        const gifOptionsBreak = document.createElement('div');
        gifOptionsBreak.style.flexBasis = '100%';
        gifOptionsBreak.style.height = '0';
        gifOptions.appendChild(gifOptionsBreak);
        const gifLayersLabel = document.createElement('span');
        gifLayersLabel.textContent = 'Layers:';
        gifOptions.appendChild(gifLayersLabel);
        const gifMap = addGifCheckbox('Map', false);
        const gifGrid = addGifCheckbox('Grid', true);
        const gifPortals = addGifCheckbox('Portals', true);
        const gifScale = addGifCheckbox('Scale', false);
        gifSection.appendChild(gifOptions);

        const gifActions = document.createElement('div');
        gifActions.style.marginTop = '8px';
        gifActions.style.display = 'flex';
        gifActions.style.gap = '6px';
        const btnGif = document.createElement('button');
        btnGif.textContent = 'Export GIF';
        btnGif.style.height = '28px';
        const btnGifCancel = document.createElement('button');
        btnGifCancel.textContent = 'Cancel';
        btnGifCancel.style.height = '28px';
        btnGifCancel.style.display = 'none';
        btnGifCancel.disabled = true;
        gifActions.appendChild(btnGif);
        gifActions.appendChild(btnGifCancel);
        gifSection.appendChild(gifActions);

        const gifStatus = document.createElement('div');
        gifStatus.style.marginTop = '6px';
        gifStatus.style.fontSize = '12px';
        gifStatus.textContent = '';
        gifSection.appendChild(gifStatus);

        btnGif.onclick = async () => {
            const boxes = Array.from(playersList.querySelectorAll('input[type="checkbox"]'));
            const selected = boxes.filter(box => box.checked).map(box => box.value);
            COLORS.setSelected(selected);
            if (!selected.length) {
                gifStatus.textContent = 'Select at least one player first.';
                return;
            }
            btnGif.disabled = true;
            btnGifCancel.disabled = false;
            btnGifCancel.style.display = '';
            const gifControls = [gifSize, gifFps, gifDuration, gifEndHold, gifMap, gifGrid, gifPortals, gifScale];
            gifControls.forEach(control => { control.disabled = true; });
            try {
                const result = await RENDER.gif.export({
                    players: selected,
                    size: Number(gifSize.value),
                    fps: Number(gifFps.value),
                    duration: Number(gifDuration.value),
                    endHoldSeconds: Number(gifEndHold.value),
                    showMap: gifMap.checked,
                    showGrid: gifGrid.checked,
                    showPortals: gifPortals.checked,
                    showScale: gifScale.checked,
                    timeWindows: gifWindows.map(window => ({ ...window })),
                    onProgress: progress => {
                        const fraction = Number(progress?.fraction);
                        const percent = Number.isFinite(fraction)
                            ? ` · ${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`
                            : '';
                        gifStatus.textContent = `${progress?.message || 'Exporting…'}${percent}`;
                    }
                });
                const mb = result.byteLength / 1048576;
                const windowInfo = gifWindows.length ? ` · ${result.timeWindows.length} windows` : '';
                gifStatus.textContent = `Saved ${result.filename} · ${mb.toFixed(2)} MB · ${result.width}×${result.height} · ${result.frameCount} frames · ${result.endHoldSeconds}s hold${windowInfo}${result.withinTarget ? '' : ' · above 9.5 MB'}`;
            } catch (error) {
                gifStatus.textContent = error?.name === 'AbortError'
                    ? 'GIF export cancelled.'
                    : `GIF export failed: ${error?.message || error}`;
            } finally {
                btnGif.disabled = false;
                btnGifCancel.disabled = true;
                btnGifCancel.style.display = 'none';
                gifControls.forEach(control => { control.disabled = false; });
            }
        };

        btnGifCancel.onclick = () => {
            if (RENDER.gif.cancel()) gifStatus.textContent = 'Cancelling GIF export...';
        };

        // ─────────────────────────────────────────────────────────────
        // Compose all sections
        // ─────────────────────────────────────────────────────────────
        fileSection.appendChild(summary);
        fileSection.appendChild(logDetails);
        container.appendChild(fileSection);
        container.appendChild(playersSection);
        container.appendChild(playbackTitle);
        container.appendChild(playbackRow);
        container.appendChild(speedRow);
        container.appendChild(seekRow);
        container.appendChild(gifSection);

        // ─────────────────────────────────────────────────────────────
        // Dialog
        // ─────────────────────────────────────────────────────────────
        const dlg = window.dialog({
            html: container,
            title: 'Trajectory Loader',
            id: 'plugin-trajectory-loader',
            dialogClass: 'plugin-trajectory-loader-dialog',
            buttons: {}, // use the "X" to close
            closeCallback: () => {
                activityResizeObserver?.disconnect();
                if (activityDrawFrame) cancelAnimationFrame(activityDrawFrame);
                UI._open = false;
            }
        });

        UI._open = true;
        return dlg;
    };

    function setup() {
        // Add a button to IITC toolbox, consistent with other plugins
        IITC.toolbox.addButton({
            label: 'Trajectory Loader',
            title: 'Load & merge COMM JSON exports',
            action: UI.open
        });
        console.log('[trajectory-loader] ready');
    }

    setup.info = plugin_info;
    if (!window.bootPlugins) window.bootPlugins = [];
    window.bootPlugins.push(setup);
    if (window.iitcLoaded && typeof setup === 'function') setup();


})(/* plugin_info */ {});

