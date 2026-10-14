// ==UserScript==
// @id             iitc-plugin-snapshot-exporter
// @name           IITC plugin: Snapshot Exporter
// @category       Misc
// @version        1.0.0
// @description    Export all portals, links, and fields currently loaded by IITC to a local JSON snapshot.
// @match          https://intel.ingress.com/*
// @grant          none
// @run-at         document-end
// ==/UserScript==

(function wrapper(plugin_info) {
    'use strict';

    if (typeof window.plugin !== 'function') window.plugin = function () {};
    plugin_info.pluginId = 'iitc-plugin-snapshot-exporter';
    plugin_info.dateTimeVersion = '2026101401';
    plugin_info.buildName = 'release';

    window.IITC = window.IITC || {};
    IITC.plugin = IITC.plugin || {};
    const plugin = (window.plugin.snapshotExporter = window.plugin.snapshotExporter || {});
    IITC.plugin.snapshotExporter = plugin;

    const FORMAT = 'iitc-map-snapshot';
    const FORMAT_VERSION = 1;

    function finiteNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function toPlainValue(value, ancestors = new WeakSet()) {
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value === 'bigint') return value.toString();
        if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return undefined;
        if (value instanceof Date) return value.toISOString();
        if (typeof value !== 'object') return String(value);
        if (ancestors.has(value)) return '[Circular]';

        ancestors.add(value);
        let result;
        if (Array.isArray(value)) {
            result = value.map(item => {
                const plain = toPlainValue(item, ancestors);
                return plain === undefined ? null : plain;
            });
        } else {
            result = {};
            for (const key of Object.keys(value)) {
                let plain;
                try {
                    plain = toPlainValue(value[key], ancestors);
                } catch (error) {
                    plain = `[Unreadable: ${error?.message || error}]`;
                }
                if (plain !== undefined) result[key] = plain;
            }
        }
        ancestors.delete(value);
        return result;
    }

    function latLngToPlain(value) {
        if (!value) return null;
        const lat = finiteNumber(value.lat ?? value.latitude);
        const lng = finiteNumber(value.lng ?? value.lon ?? value.longitude);
        return lat === null || lng === null ? null : { lat, lng };
    }

    function geometryToPlain(value) {
        if (Array.isArray(value)) return value.map(geometryToPlain).filter(item => item !== null);
        return latLngToPlain(value);
    }

    function layerData(layer) {
        if (!layer) return {};
        try {
            if (typeof layer.getDetails === 'function') return layer.getDetails() || layer.options?.data || {};
        } catch (error) {
            console.warn('[snapshot-exporter] getDetails failed', error);
        }
        return layer.options?.data || {};
    }

    function baseEntity(guid, layer) {
        const options = layer?.options || {};
        const data = layerData(layer);
        return {
            guid: String(options.guid ?? data.guid ?? guid),
            timestamp: finiteNumber(options.timestamp ?? data.timestamp),
            team: options.team ?? null,
            data: toPlainValue(data),
            rawEntity: toPlainValue(options.ent ?? data.ent ?? null)
        };
    }

    function serializePortal(guid, portal) {
        const record = baseEntity(guid, portal);
        let position = null;
        try {
            position = latLngToPlain(portal?.getLatLng?.());
        } catch (error) {
            console.warn(`[snapshot-exporter] failed to read portal position ${guid}`, error);
        }
        if (!position) {
            const latE6 = finiteNumber(record.data?.latE6);
            const lngE6 = finiteNumber(record.data?.lngE6);
            if (latE6 !== null && lngE6 !== null) position = { lat: latE6 / 1e6, lng: lngE6 / 1e6 };
        }
        return { ...record, position };
    }

    function serializePathEntity(guid, layer) {
        const record = baseEntity(guid, layer);
        let geometry = null;
        try {
            geometry = geometryToPlain(layer?.getLatLngs?.());
        } catch (error) {
            console.warn(`[snapshot-exporter] failed to read geometry ${guid}`, error);
        }
        return { ...record, geometry };
    }

    function serializeCollection(collection, serializer) {
        return Object.entries(collection || {})
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([guid, layer]) => serializer(guid, layer));
    }

    function readMapState() {
        const map = window.map;
        if (!map) return null;
        let center = null;
        let bounds = null;
        try {
            center = latLngToPlain(map.getCenter?.());
        } catch (error) {
            console.warn('[snapshot-exporter] failed to read map center', error);
        }
        try {
            const currentBounds = map.getBounds?.();
            const southWest = latLngToPlain(currentBounds?.getSouthWest?.());
            const northEast = latLngToPlain(currentBounds?.getNorthEast?.());
            if (southWest && northEast) bounds = { southWest, northEast };
        } catch (error) {
            console.warn('[snapshot-exporter] failed to read map bounds', error);
        }
        return {
            zoom: finiteNumber(map.getZoom?.()),
            center,
            bounds
        };
    }

    function formatLocalTime(date) {
        const pad = (value, width = 2) => String(value).padStart(width, '0');
        const offsetMinutes = -date.getTimezoneOffset();
        const sign = offsetMinutes >= 0 ? '+' : '-';
        const offset = Math.abs(offsetMinutes);
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
            `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
            `${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`;
    }

    function buildSnapshot(now = new Date()) {
        const portals = serializeCollection(window.portals, serializePortal);
        const links = serializeCollection(window.links, serializePathEntity);
        const fields = serializeCollection(window.fields, serializePathEntity);
        return {
            format: FORMAT,
            formatVersion: FORMAT_VERSION,
            capturedAt: now.toISOString(),
            capturedAtMs: now.getTime(),
            capturedAtLocal: formatLocalTime(now),
            timezoneOffsetMinutes: -now.getTimezoneOffset(),
            generator: {
                plugin: plugin_info.pluginId,
                version: '1.0.0',
                iitcVersion: window.script_info?.script?.version || window.script_info?.version || null
            },
            map: readMapState(),
            counts: {
                portals: portals.length,
                links: links.length,
                fields: fields.length
            },
            portals,
            links,
            fields
        };
    }

    function filenameFor(date) {
        const pad = value => String(value).padStart(2, '0');
        return `iitc-snapshot-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
            `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.json`;
    }

    function downloadSnapshot(snapshot, filename) {
        const json = JSON.stringify(snapshot, null, 2);
        const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        return { filename, byteLength: blob.size };
    }

    function exportSnapshot() {
        const now = new Date();
        const snapshot = buildSnapshot(now);
        const result = downloadSnapshot(snapshot, filenameFor(now));
        console.log(
            `[snapshot-exporter] saved ${result.filename}: ` +
            `${snapshot.counts.portals} portals, ${snapshot.counts.links} links, ${snapshot.counts.fields} fields`
        );
        return { ...result, snapshot };
    }

    plugin.buildSnapshot = buildSnapshot;
    plugin.exportSnapshot = exportSnapshot;
    plugin.downloadSnapshot = downloadSnapshot;
    plugin.toPlainValue = toPlainValue;

    function setup() {
        if (plugin._setupDone) return;
        plugin._setupDone = true;
        IITC.toolbox.addButton({
            id: 'snapshot-exporter',
            label: 'Export snapshot',
            title: 'Save all currently loaded portals, links, and fields as JSON',
            action: exportSnapshot
        });
        console.log('[snapshot-exporter] ready');
    }

    setup.info = plugin_info;
    if (!window.bootPlugins) window.bootPlugins = [];
    window.bootPlugins.push(setup);
    if (window.iitcLoaded) setup();
})(/* plugin_info */ {});
