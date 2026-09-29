(function() {
	const url = window.location.href;
	
	if (!url.includes("discord.com/") && !url.includes("discordapp.com/") && !confirm("Could not detect Discord in the URL, do you want to run the script anyway?")) {
		return;
	}
	
	if (window.DHT_LOADED) {
		alert("Discord History Tracker is already loaded.");
		return;
	}
	
	/*[IMPORTS]*/
	
	if (!DISCORD.isCompatible()) {
		alert("Discord History Tracker is not compatible with this version of Discord.");
		return;
	}
	
	window.DHT_LOADED = true;
	window.DHT_ON_UNLOAD = [];
	
	const port = 0; /*[PORT]*/
	const token = "/*[TOKEN]*/";
	STATE.setup(port, token);
	
	let delayedStopRequests = 0;
	const stopTrackingDelayed = function(callback) {
		delayedStopRequests++;
		
		window.setTimeout(() => {
			STATE.setIsTracking(false);
			delayedStopRequests--;
			
			if (callback) {
				callback();
			}
		}, 200); // give the user visual feedback after clicking the button before switching off
	};
	
	let hasJustStarted = false;
	let isSending = false;
	
	const onError = function(e) {
		console.log(e);
		GUI.setStatus(e.status === "DISCONNECTED" ? "Disconnected" : "Error");
		stopTrackingDelayed(() => isSending = false);
	};
	
	const isNoAction = function(action) {
		return action === null || action === CONSTANTS.AUTOSCROLL_ACTION_NOTHING;
	};
	
	const onTrackingContinued = async function(anyNewMessages, hasMoreBefore) {
		if (!STATE.isTracking()) {
			return;
		}
		
		GUI.setStatus("Tracking");
		
		if (hasJustStarted) {
			anyNewMessages = true;
			hasJustStarted = false;
		}
		
		isSending = false;
		
		if (SETTINGS.autoscroll) {
			let action = null;
			
			if (!hasMoreBefore) {
				console.debug("[DHT] Reached first message.");
				action = SETTINGS.afterFirstMsg;
			}
			if (isNoAction(action) && !anyNewMessages) {
				console.debug("[DHT] No new messages.");
				action = SETTINGS.afterSavedMsg;
			}
			
			if (isNoAction(action)) {
				DISCORD.loadOlderMessages();
			}
			else if (action === CONSTANTS.AUTOSCROLL_ACTION_PAUSE) {
				GUI.setStatus("Reached End");
				STATE.setIsTracking(false);
			}
			else if (action === CONSTANTS.AUTOSCROLL_ACTION_SWITCH) {
				GUI.setStatus("Switching");
				try {
					const switched = await DISCORD.selectNextTextChannel();
					if (STATE.isTracking() && !switched) {
						GUI.setStatus("Reached End");
						STATE.setIsTracking(false);
					}
				}
				catch (e) {
					onError(e);
				}
			}
		}
	};
	
	let waitUntilSendingFinishedTimer = null;
	
	const onMessagesUpdated = async (server, channel, messages, hasMoreBefore) => {
		if (!STATE.isTracking() || delayedStopRequests > 0) {
			return;
		}
		
		if (isSending) {
			window.clearTimeout(waitUntilSendingFinishedTimer);
			
			waitUntilSendingFinishedTimer = window.setTimeout(() => {
				waitUntilSendingFinishedTimer = null;
				onMessagesUpdated(server, channel, messages, hasMoreBefore);
			}, 100);
			
			return;
		}
		
		isSending = true;
		
		try {
			await STATE.addDiscordChannel(server, channel);
		} catch (e) {
			onError(e);
			return;
		}
		
		try {
			if (!messages.length) {
				isSending = false;
				await onTrackingContinued(false, hasMoreBefore);
			}
			else {
				const anyNewMessages = await STATE.addDiscordMessages(messages);
				await onTrackingContinued(anyNewMessages, hasMoreBefore);
			}
		} catch (e) {
			onError(e);
		}
	};
	
	const starter = DISCORD.setupMessageCallback(onMessagesUpdated);
	
	STATE.onTrackingStateChanged(async enabled => {
		if (enabled) {
			GUI.setStatus("Starting");
			GUI.createTrackingStyles();
			hasJustStarted = true;
			try {
				const selectedChannel = DISCORD.getSelectedChannel();
				if (selectedChannel && DISCORD.CHANNEL_TYPE.isForum(selectedChannel.type)) {
					stopTrackingDelayed(() => alert("Open a forum post first, then start tracking its focused chat."));
					hasJustStarted = false;
				}
				else if (!starter()) {
					stopTrackingDelayed(() => alert("Cannot see any messages."));
					hasJustStarted = false;
				}
			}
			catch (e) {
				onError(e);
			}
		}
		else {
			DISCORD.cancelForumTraversal();
			isSending = false;
			GUI.deleteTrackingStyles();
		}
	});
	
	GUI.showController();
	
	if (IS_FIRST_RUN) {
		GUI.showSettings();
	}
})();
/*[DEBUGGER]*/
