const package_json = require('./package.json');
const mqtt = require('mqtt');
const fs = require('fs');

let mqttClient, roonCore, roonZones = {};
let debug = false;
let trace = false;
let mqttData = {};

const RoonApi = require("node-roon-api"),
    RoonApiStatus = require("node-roon-api-status"),
    RoonApiTransport = require("node-roon-api-transport"),
    RoonApiSettings = require('node-roon-api-settings'),
    RoonApiBrowse = require('node-roon-api-browse');

function mqttPublishJson(mqttBase, mqttClient, jsonData, retainFlag) {
    if (mqttClient && mqttClient.connected) {
        for (let attribute in jsonData) {
            let attributeTopic = toMqttTopic(attribute);
            if (typeof jsonData[attribute] === 'object') {
                mqttPublishJson(mqttBase + '/' + attributeTopic, mqttClient, jsonData[attribute], retainFlag);
            } else if (typeof mqttData[mqttBase + '/' + attributeTopic] === 'undefined' || mqttData[mqttBase + '/' + attributeTopic] !== jsonData[attribute].toString()) {
                if (trace) {
                    console.log('*** sending MQTT: ' + mqttBase + '/' + attribute + '=' + jsonData[attribute]);
                }
                mqttData[mqttBase + '/' + attributeTopic] = jsonData[attribute].toString();
                mqttClient.publish(mqttBase + '/' + attributeTopic, jsonData[attribute].toString(), {'retain': retainFlag});
            } else {
                if (trace) {
                    console.log('*** mqtt_publish_JSON nothing to publish to %s', mqttBase);
                }
            }
        }
    } else {
        if (debug) {
            console.log('*** mqtt_publish_JSON called but unable to publish. mqtt_client=%s', typeof mqttClient !== 'undefined' ? mqttClient : 'undefined');
        }
    }
}

let mySettings;

function mqttGetClient() {
    try {
        if (mqttClient) {
            mqttClient.end();
        }
        let protocol = "mqtt://";
        if (mySettings.mqttprotocol) {
            protocol = mySettings.mqttprotocol;
        }
        let options = {};
        options.clean = true;
        options.clientId = "roon-extension-mqtt-" + (Math.random().toString(36).replace(/[^a-z]+/g, '').substr(0, 5)); //+= "." + hostname;
        options.servername = mySettings.mqttbroker;
        options.port = mySettings.mqttport;
        options.will = {topic: mySettings.mqttroot + '/online', payload: 'false', retain: true};
        if (mySettings.mqttusername && mySettings.mqttpassword) {
            options.username = mySettings.mqttusername;
            options.password = mySettings.mqttpassword;
        }
        if (typeof mySettings.tls_rejectUnauthorized !== 'undefined') {
            options.rejectUnauthorized = mySettings.tls_rejectUnauthorized;
        }
        if (mySettings.tls_cafile) {
            try {
                options.ca = fs.readFileSync('config/' + mySettings.tls_cafile);
            } catch (err) {
                roonSvcStatus.set_status("Unable to open CA File (" + err + ")", true);
                return null;
            }
        }

        if (debug) {
            console.log('*** trying mqtt connect to %s with options=%s', protocol + mySettings.mqttbroker, JSON.stringify(options));
        }
        mqttClient = mqtt.connect(protocol + mySettings.mqttbroker, options);

        mqttClient.on('error', function (err) {
            roonSvcStatus.set_status("MQTT Broker Offline (" + err + ")", true);
        });

        mqttClient.on('connect', () => {
            mqttClient.publish(mySettings.mqttroot + '/online', 'true', {retain: true});
            mqttClient.subscribe(mySettings.mqttroot + '/+/command');
            //mqtt_client.subscribe(mysettings.mqttroot + '/browse');
            mqttClient.subscribe(mySettings.mqttroot + '/+/browse/+');
            mqttClient.subscribe(mySettings.mqttroot + '/+/outputs/+/volume/set');
            mqttClient.subscribe(mySettings.mqttroot + "/+/outputs/+/volume/set/+");
            mqttClient.subscribe(mySettings.mqttroot + "/+/settings/set/+");
            mqttClient.subscribe(mySettings.mqttroot + "/+/outputs/+/power");
            mqttClient.subscribe(mySettings.mqttroot + '/+/outputs/add');
            mqttClient.subscribe(mySettings.mqttroot + '/+/outputs/remove');
            mqttClient.subscribe(mySettings.mqttroot + "/+/seek/set");
            roonSvcStatus.set_status("MQTT Broker Connected", false);
        });

        mqttClient.on('offline', () => {
            roonSvcStatus.set_status("MQTT Broker Offline", true);
        });

        mqttClient.on('message', function (topic, message) {
            if (debug) {
                console.log('received mqtt packet: topic=%s, message=%s', topic, message);
            }
            let topicSplit = topic.split("/");
            if (typeof roonCore !== 'undefined' && topicSplit[0] === mySettings.mqttroot) {
                if (debug) {
                    console.log('*** we know of zones: %s', Object.keys(roonZones));
                }
                let roonZone = roonZoneFindByMqttTopic(topicSplit[1]);
                if (roonZone == null) {
                    console.log('*** zone %s not found!', topicSplit[1]);
                } else {
                    let zoneName = roonZone["display_name"];
                    if (topicSplit[2] === 'command' && topicSplit.length === 3) {
                        // Control entire zone
                        controlZone(roonZone["zone_id"], message);
                    } else if (topicSplit[2] === "settings" && topicSplit[3] === "set" && topicSplit.length === 5) {
                        // Change a zone's settings
                        let setting = topicSplit[4];
                        if (debug) {
                            console.log("*** change settings %s to zone with id=%s", setting, roonZone["zone_id"]);
                        }
                        changeZoneSettings(roonZone, setting, message);
                    } else if (topicSplit[2] === 'command' && topicSplit.length === 4) {
                        // Control single output in zone
                        let output = roonZoneFindOutputByName(zoneName, topicSplit[3]);
                        if (output == null) {
                            console.log('*** output %s not found in zone %s!', topicSplit[3], zoneName);
                        } else {
                            controlOutput(output["output_id"], message, zoneName);
                        }
                    } else if (topicSplit[2] === 'outputs' && topicSplit[4] === 'volume' && topicSplit[5] === "set") {
                        // adjust volume of an output
                        if (debug) {
                            console.log('*** find output id for zone=%s, output=%s', zoneName, topicSplit[3]);
                        }
                        let output = roonZoneFindOutputByName(zoneName, topicSplit[3]);
                        if (output == null) {
                            console.log('*** output %s not found in zone %s!', topicSplit[3], zoneName);
                        } else if (typeof message === 'undefined' || message.toString() === '') {
                            console.log('*** no message for volume set command!');
                        } else {
                            switch (topicSplit[6]) {
                                case "relative":
                                    adjustOutputVolume(output["output_id"], message, "relative");
                                    break;
                                case "relative_step":
                                    adjustOutputVolume(output["output_id"], message, "relative_step");
                                    break;
                                case "absolute":
                                    adjustOutputVolume(output["output_id"], message, "absolute");
                                    break;
                                default:
                                    adjustOutputVolume(output["output_id"], message, "absolute");
                            }
                        }
                    } else if (topicSplit[2] === "outputs" && topicSplit.length === 4) {
                        if (debug) {
                            console.log('*** %s output %s to zone=%s', topicSplit[3], message, zoneName);
                        }
                        let output = roonOutputFindByName(message);
                        if (output != null) {
                            if (topicSplit[3] === 'add') {
                                addOutputToZone(roonZone, output["output_id"], message);
                            } else if (topicSplit[3] === 'remove') {
                                removeOutputFromZone(roonZone, output["output_id"], message);
                            }
                        } else if (debug) {
                            console.log('*** output %s not found', message);
                        }
                    } else if (topicSplit[2] === "outputs" && topicSplit[4] === "power") {
                        if (debug) {
                            console.log("*** find output id for zone=%s, output=%s", zoneName, topicSplit[3]);
                        }
                        let output = roonZoneFindOutputByName(zoneName, topicSplit[3]);
                        if (output == null) {
                            console.log("*** output %s not found in zone %s!", topicSplit[3], zoneName);
                        } else if (typeof message === "undefined" || message.toString() === "") {
                            console.log("*** no message for power command!");
                        } else {
                            changeOutputPower(output["output_id"], message);
                        }
                    }
                    if (topicSplit[2] === "seek" && topicSplit[3] === "set" && topicSplit.length === 4) {
                        // Change seek position for a zone
                        if (debug) {
                            console.log("*** go to position %s in zone with id=%s", message, roonZone["zone_id"]);
                        }
                        if (!isNaN(parseInt(message.toString(), 10))) {
                            roonCore.services.RoonApiTransport.seek(roonZone["zone_id"], "absolute", parseInt(message.toString(), 10));
                        }
                    } else if (topicSplit[2] === 'browse' && topicSplit.length === 4) {
                        let zoneId = roonZone["zone_id"];
                        let hierarchy = topicSplit[3].toString().toLowerCase();
                        let action = {};
                        try {
                            action = JSON.parse(message.toString().toLowerCase());
                        } catch (e) {
                            console.log('*** no valid JSON in message. Assume only title is passed. message: %s', message.toString());
                            action.title = message.toString().toLowerCase();
                        }
                        if (action.title) {
                            browseItem(zoneId, hierarchy, action);
                        }
                    } else {
                        if (debug) {
                            console.log('*** unknown topic=% message=%s', topic, message,);
                        }
                    }
                }
            }
        });
    } catch (err) {
        if (debug) {
            console.log('*** Error connecting: %s', err);
        }
        roonSvcStatus.set_status("MQTT Broker Offline (error)", true);
    }
}

function controlZone(zoneId, message) {
    if (debug) {
        console.log('*** sending command %s to zone with id=%s', message, zoneId);
    }
    roonCore.services.RoonApiTransport.control(zoneId, message.toString());
}

function controlOutput(outputId, message, zoneName) {
    if (debug) {
        console.log('*** sending command %s to output with id=%s in zone=%s', message, outputId, zoneName);
    }
    roonCore.services.RoonApiTransport.control(outputId, message.toString());
}

function adjustOutputVolume(outputId, message, how) {
    if (message.toString().toLowerCase() === "mute") {
        roonCore.services.RoonApiTransport.mute(outputId, "mute");
    } else if (message.toString().toLowerCase() === "unmute") {
        roonCore.services.RoonApiTransport.mute(outputId, "unmute");
    } else if (!isNaN(message)) {
        roonCore.services.RoonApiTransport.change_volume(outputId, how, parseFloat(message.toString()), function () {
            roonCore.services.RoonApiTransport.mute(outputId, "unmute");
        });
    } else if (debug) {
        console.log('*** invalid message for volume/set topic message=%s', message)
    }
}

function addOutputToZone(roonZone, outputId, message) {
    let zoneName = roonZone["display_name"];
    let currentOutputs = [];
    for (let index in roonZone["outputs"]) {
        currentOutputs.push(roonZone["outputs"][index]["output_id"]);
    }
    if (trace) {
        console.log('*** currentOutputs=%s output["output_id"]=%s', currentOutputs, outputId);
    }
    if (!currentOutputs.includes(outputId)) {
        if (roonZone.outputs[Object.keys(roonZone.outputs)[0]].can_group_with_output_ids.includes(outputId)) {
            currentOutputs.push(outputId);
            roonCore.services.RoonApiTransport.group_outputs(currentOutputs);
        } else if (debug) {
            console.log('*** output %s cannot begrouped in zone %s', message, zoneName);
        }
    } else if (debug) {
        console.log('*** output %s already grouped in zone %s', message, zoneName);
    }
}

function removeOutputFromZone(roonZone, outputId, message) {
    let zoneName = roonZone["display_name"];
    if (currentOutputs.includes(outputId)) { //FIX: no definition of currentOutputs
        roonCore.services.RoonApiTransport.ungroup_outputs([outputId]);
    } else if (debug) {
        console.log('*** output %s not found in zone %s', message, zoneName);
    }
}

function changeZoneSettings(roonZone, setting, message) {
    let zoneId = roonZone["zone_id"];
    if (setting === "shuffle") {
        let roonSettings = {
            shuffle: message.toString().toLowerCase()
        };
        roonCore.services.RoonApiTransport.change_settings(zoneId, roonSettings);
    } else if (setting === "repeat") {
        let loop_mode = "disabled";
        if (message.toString().toLowerCase() === "one") {
            loop_mode = "loop_one";
        } else if (message.toString().toLowerCase() === "all") {
            loop_mode = "loop";
        }
        let roonSettings = {
            loop: loop_mode
        };
        roonCore.services.RoonApiTransport.change_settings(zoneId, roonSettings);
    }
}

function changeOutputPower(outputId, message) {
    if (message.toString().toLowerCase() === "on") {
        roonCore.services.RoonApiTransport.convenience_switch(outputId, {});
        if (debug) {
            console.log("*** Wake-up %s from standby", outputId);
        }
    } else if (message.toString().toLowerCase() === "standby") {
        roonCore.services.RoonApiTransport.standby(outputId, {});
        if (debug) {
            console.log("*** Send %s to standby", outputId);
        }
    } else if (debug) {
        console.log("*** invalid message for power topic message=%s", message);
    }
}

function toMqttTopic(input) {
    return input.replace(/[#+]/g, '-');
}

function zoneToMqttTopic(input) {
    return toMqttTopic(input.replace(/ \+ [0-9]?/, ''));
}

function roonZoneFindByMqttTopic(zonetopic) {
    for (let zoneName in roonZones) {
        if (toMqttTopic(zoneName.replace(/ \+ [0-9]?/, '')) === toMqttTopic(zonetopic)) {
            return roonZones[zoneName];
        }
    }
    return null;
}

function roonZoneFindById(zoneid) {
    for (let zoneName in roonZones) {
        if (roonZones[zoneName]["zone_id"] === zoneid) {
            return zoneName;
        }
    }
    return null;
}

function roonZoneFindOutputByName(zoneName, outputName) {
    for (let output in roonZones[zoneName]["outputs"]) {
        if (toMqttTopic(roonZones[zoneName]["outputs"][output]["display_name"].toLowerCase()) === toMqttTopic(outputName.toString().toLowerCase())) {
            return roonZones[zoneName]["outputs"][output];
        }
    }
    return null;
}

function roonOutputFindByName(outputName) {
    for (let zoneName in roonZones) {
        for (let output in roonZones[zoneName]["outputs"]) {
            if (roonZones[zoneName]["outputs"][output]["display_name"].toLowerCase() === outputName.toString().toLowerCase()) {
                return roonZones[zoneName]["outputs"][output];
            }
        }
    }
    return null;
}


function roonZoneJsonChangeOutputs(zoneData, envData) {
    let newOutputs = {};
    for (let index in zoneData["outputs"]) {
        let output = JSON.parse(JSON.stringify(zoneData["outputs"][index]));
        output["env"] = JSON.stringify(Object.assign(
            envData,
            {
                output_id: output.output_id,
            }
        ));
        let volume = output.volume;
        if (volume) {
            output.volume.percent = (volume.value - volume.hard_limit_min) / (volume.hard_limit_max - volume.hard_limit_min) * 100.0;
        }
        newOutputs[zoneData["outputs"][index]["display_name"]] = output;
    }
    zoneData["outputs"] = JSON.parse(JSON.stringify(newOutputs));
    return zoneData;
}

function makeLayout(settings) {
    let l = {
        values: settings,
        layout: [],
        has_error: false
    };
    l.layout.push({
        type: "label",
        title: "MQTT Broker settings",
    });
    l.layout.push({
        type: "dropdown",
        title: "Protocol",
        values: [
            {title: "mqtt", value: 'mqtt://'},
            {title: "mqtts", value: 'mqtts://'}
        ],
        setting: "mqttprotocol",
    });
    l.layout.push({
        type: "string",
        title: "Broker Host/IP",
        setting: "mqttbroker",
    });
    l.layout.push({
        type: "integer",
        title: "Broker TCP Port",
        setting: "mqttport",
    });
    l.layout.push({
        type: "string",
        title: "MQTT Root Topic",
        setting: "mqttroot",
    });
    l.layout.push({
        type: "label",
        title: "Authentication (optional)",
    });
    l.layout.push({
        type: "string",
        title: "Username",
        setting: "mqttusername",
    });
    l.layout.push({
        type: "string",
        title: "Password",
        setting: "mqttpassword",
    });
    l.layout.push({
        type: "label",
        title: "TLS options (optional)",
    });
    l.layout.push({
        type: "dropdown",
        title: "Validate Certificate Chain ",
        setting: "tls_rejectUnauthorized",
        values: [
            {title: "No (allow self-signed)", value: false},
            {title: "Yes (more secure)", value: true}
        ],
    });
    l.layout.push({
        type: "string",
        title: "CA Certificate File",
        description: "test",
        setting: "tls_cafile",
    });
    l.layout.push({
        type: "label",
        title: "Logging",
    });
    l.layout.push({
        type: "dropdown",
        title: "Debug output",
        values: [
            {title: "Disable", value: false},
            {title: "Enable", value: true}
        ],
        setting: "debug"
    });
    l.layout.push({
        type: "dropdown",
        title: "Retain messages",
        values: [
            {title: "Disable", value: false},
            {title: "Enable", value: true}
        ],
        setting: "retain"
    });
    return l;
}

function browseItem(zoneId, hierarchy, action) {
    if (action && hierarchy) {
        let opts = {hierarchy: hierarchy, pop_all: true, action: action};
        roonCore.services.RoonApiBrowse.browse(opts, (err, r) => loadItemCallback(err, r, opts, function (itemKey) {
            if (itemKey) {
                opts = {
                    hierarchy: hierarchy,
                    item_key: itemKey,
                    zone_or_output_id: zoneId,
                };
                roonCore.services.RoonApiBrowse.browse(opts, (err, r) => {
                    if (debug) {
                        console.log('*** RoonApiBrowse.browse control result: err=%s', JSON.stringify(err));
                        console.log('*** RoonApiBrowse.browse control result: r=%s', JSON.stringify(r));
                    }
                });
            } else if (debug) {
                console.log('*** Requested title: "%s" not found in hierarchy "%s".', action.title, hierarchy);
            }
        }));
    } else if (debug) {
        console.log('*** Incomplete browse request. hierarchy=%s, action=%s', hierarchy, JSON.stringify(action));
    }
}

function loadItemCallback(err, r, opts, cb, offset) {
    let querySize = 100;
    if (!offset) offset = 0;

    if (debug) {
        console.log('*** RoonApiBrowse.browse result: err=%s', JSON.stringify(err));
        console.log('*** RoonApiBrowse.browse result: r=%s', JSON.stringify(r));
    }
    opts.count = querySize;
    opts.offset = offset;

    roonCore.services.RoonApiBrowse.load(opts, (err, r) => {
        if (debug) {
            console.log('*** RoonApiBrowse.load result: err=%s', JSON.stringify(err));
            console.log('*** RoonApiBrowse.load result: r=%s', JSON.stringify(r));
        }
        if (!err) {
            let foundItem;
            let actionListItem;
            for (let i in r.items) {
                let item = r.items[i]
                if (debug) {
                    console.log('*** Checking item for requested action=%s item=%s', JSON.stringify(opts.action), JSON.stringify(item));
                }
                if (!opts.action.title && item.hint === "action") {
                    // If no action.title is available, play first actionable item
                    foundItem = item;
                    break;
                } else if (item.title.toLowerCase() === opts.action.title) {
                    foundItem = item;
                    break;
                } else {
                    if (!actionListItem && item.hint === 'action_list') {
                        actionListItem = item;
                    }
                }
            }
            if (!foundItem && r.items.length === querySize) {
                loadItemCallback(err, r, opts, cb, offset + querySize);
            } else if (foundItem && foundItem.hint === 'list') {
                opts = {
                    hierarchy: opts.hierarchy,
                    item_key: foundItem.item_key,
                    action: {
                        title: opts.action.album,
                        action: opts.action.action
                    }
                };
                roonCore.services.RoonApiBrowse.browse(opts, (err, r) => loadItemCallback(err, r, opts, cb));
            } else if (!foundItem && actionListItem) {
                opts = {
                    hierarchy: opts.hierarchy,
                    item_key: actionListItem.item_key,
                    action: {
                        title: opts.action.action
                    }
                };
                roonCore.services.RoonApiBrowse.browse(opts, (err, r) => loadItemCallback(err, r, opts, cb));
            } else {
                let itemKey;
                if (foundItem) {
                    itemKey = foundItem.item_key;
                }
                cb && cb(itemKey);
            }
        }
    });
}

const roon = new RoonApi({
    extension_id: 'nl.fjgalesloot.mqtt',
    display_name: "MQTT Extension",
    display_version: package_json.version,
    publisher: 'Floris Jan Galesloot',
    email: 'fjgalesloot@triplew.nl',
    website: 'https://github.com/fjgalesloot/roon-extension-mqtt',

    core_paired: function (core_) {
        roonCore = core_;
        let transport = core_.services.RoonApiTransport;
        transport.subscribe_zones(function (cmd, data) {
            if (debug) {
                console.log('*** we know of zones: %s', Object.keys(roonZones));
            }
            if (typeof data !== "undefined") {
                for (let zoneEvent in data) {
                    if (debug) {
                        console.log('*** zoneevent=%s', zoneEvent);
                    }
                    if (zoneEvent === 'zones_removed') {
                        for (let zoneIndex in data[zoneEvent]) {
                            let zoneId = data[zoneEvent][zoneIndex];
                            let zoneName = roonZoneFindById(zoneId);
                            if (debug) {
                                console.log('*** removed zone with id %s and name %s', zoneId, zoneName);
                            }
                            mqttPublishJson(mySettings.mqttroot + '/' + zoneToMqttTopic(zoneName), mqttClient, {'state': 'removed'}, mySettings.retain);
                            delete roonZones[zoneName];
                        }
                    } else {
                        let zones = data[zoneEvent];
                        for (let index in zones) {
                            let host_url = roonCore.moo.transport.ws.url.match(/ws:\/\/([\d,\.,:]+)\/*/)[1];
                            const envData = {
                                core_id: roonCore.core_id,
                                core_display_name: roonCore.display_name,
                                core_display_version: roonCore.display_version,
                                core_address: host_url.split(":")[0],
                                core_port: host_url.split(":")[1],
                                zone_id: zones[index].zone_id,
                                zone_display_name: zones[index].display_name,
                                zone_status: zones[index].state,
                            };
                            let zoneData = roonZoneJsonChangeOutputs(zones[index], envData);
                            let zoneName = zoneData.display_name || roonZoneFindById(zoneData.zone_id);
                            if (zoneName) {
                                if (zoneEvent !== 'zones_seek_changed') {
                                    // zones_seek_changed only passes seek/queue position. Do not refresh zone cache
                                    roonZones[zoneName] = JSON.parse(JSON.stringify(zoneData));
                                } else {
                                    roonZones[zoneName].queue_time_remaining = zoneData.queue_time_remaining;
                                    roonZones[zoneName].seek_position = zoneData.seek_position;
                                }
                                if (trace) {
                                    console.log('*** publising(if needed) to zone %s: %s', zoneName, JSON.stringify(zoneData));
                                }
                                mqttPublishJson(mySettings.mqttroot + '/' + zoneToMqttTopic(zoneName), mqttClient, zoneData, mySettings.retain);
                            }
                        }
                    }
                }
            }
        });
    },

    core_unpaired: function (core_) {
        console.log(core_.core_id,
            core_.display_name,
            core_.display_version,
            "-",
            "LOST");
    }
});

let saveDefaultSetting = false;
mySettings = roon.load_config("settings");
if (!mySettings) {
    mySettings = {
        mqttbroker: "localhost",
        mqttprotocol: "mqtt://",
        mqttport: 1883,
        mqttroot: 'roon',
        debug: false,
        tls_rejectUnauthorized: false
    }
    saveDefaultSetting = true;
}

if (typeof mySettings.debug !== 'undefined') {
    debug = mySettings.debug;
} else {
    // Set debug to false when setting is
    mySettings.debug = false;
    saveDefaultSetting = true;
}
if (typeof mySettings.mqttport === 'undefined') {
    mySettings.mqttport = 1883;
    saveDefaultSetting = true;
}
if (typeof mySettings.mqttroot === 'undefined') {
    mySettings.mqttroot = 'roon';
    saveDefaultSetting = true;
} else if (mySettings.mqttroot !== toMqttTopic(mySettings.mqttroot)) {
    mySettings.mqttroot = toMqttTopic(mySettings.mqttroot);
    saveDefaultSetting = true;
}
if (typeof mySettings.tls_rejectUnauthorized === 'undefined') {
    mySettings.tls_rejectUnauthorized = false;
    saveDefaultSetting = true;
}

if (saveDefaultSetting) {
    roon.save_config("settings", mySettings);
}
if (debug) {
    console.log('*** starting with Settings=%s', JSON.stringify(mySettings));
}
let roonSvcStatus = new RoonApiStatus(roon);

let roonSvcSettings = new RoonApiSettings(roon, {
    get_settings: function (cb) {
        cb(makeLayout(mySettings));
    },
    save_settings: function (req, isDryRun, settings) {
        let l = makeLayout(settings.values);
        req.send_complete(l.has_error ? "NotValid" : "Success", {settings: l});

        if (!isDryRun && !l.has_error) {
            mySettings = l.values;
            roonSvcSettings.update_settings(l);
            roon.save_config("settings", mySettings);
        }
        if (typeof mySettings.debug !== 'undefined') {
            debug = mySettings.debug;
        }
        if (debug) {
            console.log('*** new setting, reconnecting mqtt client. Settings=%s', JSON.stringify(mySettings));
        }
        mqttGetClient();
    }
});

roon.init_services({
    required_services: [RoonApiTransport, RoonApiBrowse],
    provided_services: [roonSvcSettings, roonSvcStatus]
});

mqttGetClient();
roon.start_discovery();
