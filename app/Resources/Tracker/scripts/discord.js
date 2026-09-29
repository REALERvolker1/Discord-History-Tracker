// noinspection JSUnresolvedVariable
// noinspection LocalVariableNamingConventionJS
class DISCORD {
	
	// https://discord.com/developers/docs/resources/channel#channel-object-channel-types
	static CHANNEL_TYPE = {
		GUILD_TEXT: 0,
		DM: 1,
		GROUP_DM: 3,
		GUILD_ANNOUNCEMENT: 5,
		ANNOUNCEMENT_THREAD: 10,
		PUBLIC_THREAD: 11,
		PRIVATE_THREAD: 12,
		GUILD_FORUM: 15,
		
		isPrivate(type) {
			return type === this.DM
				|| type === this.GROUP_DM;
		},
		
		isThread(type) {
			return type === this.ANNOUNCEMENT_THREAD
				|| type === this.PUBLIC_THREAD
				|| type === this.PRIVATE_THREAD;
		},
		
		isForum(type) {
			return type === this.GUILD_FORUM;
		},
		
		isNavigableGuildChannel(type) {
			return type === this.GUILD_TEXT
				|| type === this.GUILD_ANNOUNCEMENT
				|| this.isThread(type)
				|| this.isForum(type);
		}
	};
	
	// https://discord.com/developers/docs/resources/channel#message-object-message-types
	static MESSAGE_TYPE = {
		DEFAULT: 0,
		REPLY: 19,
		THREAD_STARTER: 21
	};
	
	// https://discord.com/developers/docs/topics/permissions#permissions-bitwise-permission-flags
	static PERMISSION = {
		VIEW_CHANNEL: 1n << 10n
	};
	
	/**
	 * @type {Object}
	 * @property {function(String): ?DiscordGuild} getGuild
	 */
	static #guildStore = WEBPACK.findModule("guildStore", WEBPACK.filterByProps("getGuild", "getGuilds", "getGuildIds"));
	
	/**
	 * @type {Object}
	 * @property {function(String): Boolean} isOptInEnabled
	 * @property {function(String): Set<String>} getOptedInChannels
	 */
	static #guildSettings = WEBPACK.findModule("guildSettings", WEBPACK.filterByProps("isOptInEnabled", "getOptedInChannels"));
	
	/**
	 * @type {Object}
	 * @property {function(String): ?DiscordChannel} getChannel
	 * @property {function(String): Array<DiscordChannel>} getMutableGuildChannelsForGuild
	 * @property {function(): Array<DiscordChannel>} getSortedPrivateChannels
	 */
	static #channelStore = WEBPACK.findModule("channelStore", WEBPACK.filterByProps("getChannel", "getMutableGuildChannelsForGuild", "getSortedPrivateChannels"));
	
	/**
	 * @type {function(BigInt, Object): Boolean}
	 */
	static #hasPermission = WEBPACK.findFunction("can", [ "getGuildPermissions", "getChannelPermissions" ]);
	
	/**
	 * @type {function(String): MessageData}
	 */
	static #getMessages = WEBPACK.findFunction("getMessages", [ "isLoadingMessages" ]);
	
	/**
	 * @type {function(String): void}
	 */
	static #jumpToMessage = WEBPACK.findFunction("jumpToMessage");
	
	/**
	 * @type {function(): String}
	 */
	static #getCurrentlySelectedChannelId = WEBPACK.findFunction("getCurrentlySelectedChannelId");
	
	/**
	 * @type {function(String): void}
	 */
	static #selectPrivateChannel = WEBPACK.findFunction("selectPrivateChannel", [ "selectChannel" ]);
	
	/**
	 * @type {function(String, Object, String=null): void}
	 */
	static #transitionToGuildSync = WEBPACK.findFunction("transitionToGuildSync");
	
	static #forumQueue = [];
	static #forumParentId = null;
	static #forumThreadPositions = new Map();
	static #forumTraversalVersion = 0;
	static #scrollDownNudgeTimer = null;
	
	static isCompatible() {
		return !!this.#guildStore
			&& !!this.#guildSettings
			&& !!this.#channelStore
			&& !!this.#hasPermission
			&& !!this.#getMessages
			&& !!this.#jumpToMessage
			&& !!this.#getCurrentlySelectedChannelId
			&& !!this.#selectPrivateChannel
			&& !!this.#transitionToGuildSync;
	}
	
	static getChannel(channelId) {
		return this.#channelStore.getChannel(channelId);
	}
	
	static getSelectedChannel() {
		const channelId = this.#getCurrentlySelectedChannelId();
		return channelId ? this.#channelStore.getChannel(channelId) : null;
	}
	
	static getForumThreadPosition(channelId) {
		return this.#forumThreadPositions.get(channelId);
	}
	
	static cancelForumTraversal() {
		++this.#forumTraversalVersion;
		this.#forumQueue = [];
		this.#forumParentId = null;
		this.#forumThreadPositions.clear();
	}
	
	static #sleep(ms) {
		return new Promise(resolve => window.setTimeout(resolve, ms));
	}
	
	static async #waitForSelectedChannel(channelId, traversalVersion) {
		for (let i = 0; i < 50; i++) {
			if (traversalVersion !== this.#forumTraversalVersion) return false;
			if (this.#getCurrentlySelectedChannelId() === channelId) return true;
			await this.#sleep(100);
		}
		return false;
	}
	
	static #getForumPostIdFromLink(link, forumChannel) {
		let url;
		try { url = new URL(link.getAttribute("href"), window.location.origin); }
		catch { return null; }
		
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts.length < 3 || parts[0] !== "channels" || parts[1] !== forumChannel.guild_id) return null;
		
		// Discord renders forum cards with routes like:
		// /channels/<guild>/<forum>/threads/<thread>
		// The thread may not be present in ChannelStore until the post is opened,
		// so trust the explicit forum/thread route instead of requiring store lookup.
		if (parts[2] === forumChannel.id) {
			if (parts[3] === "threads" && parts[4]) {
				return parts[4];
			}
			
			// Keep compatibility with alternate forum routes that put the thread
			// directly after the parent forum ID.
			if (parts[3] && /^\\d+$/.test(parts[3])) {
				return parts[3];
			}
		}
		
		// Existing/full-view thread routes look like /channels/<guild>/<thread>.
		// Verify those through ChannelStore so unrelated channel links in the page
		// are not mistaken for forum posts.
		const channelId = parts[2];
		const channel = this.#channelStore.getChannel(channelId);
		return channel && channel.parent_id === forumChannel.id && this.CHANNEL_TYPE.isThread(channel.type) ? channelId : null;
	}
	
	static #scanForumPostLinks(forumChannel, orderedIds, seenIds) {
		let firstMatchingLink = null;
		for (const link of document.querySelectorAll("[href]")) {
			const channelId = this.#getForumPostIdFromLink(link, forumChannel);
			if (!channelId) continue;
			if (!firstMatchingLink) firstMatchingLink = link;
			if (!seenIds.has(channelId)) {
				seenIds.add(channelId);
				orderedIds.push(channelId);
			}
		}
		return firstMatchingLink;
	}
	
	static #findScrollableAncestor(element) {
		for (let parent = element?.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
			const style = window.getComputedStyle(parent);
			if ((style.overflowY === "auto" || style.overflowY === "scroll") && parent.scrollHeight > parent.clientHeight + 8) return parent;
		}
		return null;
	}
	
	static #addKnownForumThreads(forumChannel, orderedIds, seenIds) {
		const guildChannelMap = this.#channelStore.getMutableGuildChannelsForGuild(forumChannel.guild_id);
		const knownThreads = Object.values(guildChannelMap)
			.filter(channel => channel.parent_id === forumChannel.id && this.CHANNEL_TYPE.isThread(channel.type))
			.sort((a, b) => a.id === b.id ? 0 : (BigInt(a.id) > BigInt(b.id) ? -1 : 1));
		for (const channel of knownThreads) {
			if (!seenIds.has(channel.id)) {
				seenIds.add(channel.id);
				orderedIds.push(channel.id);
			}
		}
	}
	
	static async startForumTraversal(forumChannel, skipThreadId = null) {
		if (!forumChannel || !this.CHANNEL_TYPE.isForum(forumChannel.type)) return false;
		const traversalVersion = ++this.#forumTraversalVersion;
		this.#forumQueue = [];
		this.#forumParentId = forumChannel.id;
		this.#forumThreadPositions.clear();
		if (this.#getCurrentlySelectedChannelId() !== forumChannel.id) {
			this.#transitionToGuildSync(forumChannel.guild_id, {}, forumChannel.id);
			if (!await this.#waitForSelectedChannel(forumChannel.id, traversalVersion)) return false;
		}
		await this.#sleep(300);
		if (traversalVersion !== this.#forumTraversalVersion) return false;
		const orderedIds = [];
		const seenIds = new Set();
		const firstMatchingLink = this.#scanForumPostLinks(forumChannel, orderedIds, seenIds);
		const scroller = this.#findScrollableAncestor(firstMatchingLink);
		if (scroller) {
			scroller.scrollTop = 0;
			scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
			await this.#sleep(250);
			this.#scanForumPostLinks(forumChannel, orderedIds, seenIds);
			let stableBottomPasses = 0;
			for (let i = 0; i < 1000 && stableBottomPasses < 4; i++) {
				if (traversalVersion !== this.#forumTraversalVersion) return false;
				const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
				const atBottom = scroller.scrollTop >= maxScrollTop - 2;
				if (!atBottom) {
					const step = Math.max(300, Math.floor(scroller.clientHeight * 0.8));
					scroller.scrollTop = Math.min(maxScrollTop, scroller.scrollTop + step);
					scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
					await this.#sleep(150);
					this.#scanForumPostLinks(forumChannel, orderedIds, seenIds);
					stableBottomPasses = 0;
				}
				else {
					const previousHeight = scroller.scrollHeight;
					scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
					await this.#sleep(400);
					this.#scanForumPostLinks(forumChannel, orderedIds, seenIds);
					if (scroller.scrollHeight > previousHeight + 1 || scroller.scrollTop < scroller.scrollHeight - scroller.clientHeight - 2) stableBottomPasses = 0;
					else ++stableBottomPasses;
				}
			}
		}
		this.#addKnownForumThreads(forumChannel, orderedIds, seenIds);
		if (traversalVersion !== this.#forumTraversalVersion) return false;
		orderedIds.forEach((id, index) => this.#forumThreadPositions.set(id, index));
		if (skipThreadId) {
			const currentIndex = orderedIds.indexOf(skipThreadId);
			this.#forumQueue = currentIndex === -1 ? orderedIds.filter(id => id !== skipThreadId) : orderedIds.slice(currentIndex + 1);
		}
		else this.#forumQueue = orderedIds.slice();
		console.debug("[DHT] Discovered " + orderedIds.length + " forum posts in #" + forumChannel.name + ".");
		if (this.#forumQueue.length === 0) return false;
		this.#transitionToGuildSync(forumChannel.guild_id, {}, this.#forumQueue.shift());
		return true;
	}
	
	static getMessageOuterElement() {
		return DOM.queryReactClass("messagesWrapper");
	}
	
	static getMessageScrollerElement() {
		return DOM.queryReactClass("scroller", this.getMessageOuterElement());
	}
	
	static loadOlderMessages() {
		const view = this.getMessageScrollerElement();
		
		if (view.scrollTop > 0) {
			view.scrollTop = 0;
		}
		
		window.clearTimeout(this.#scrollDownNudgeTimer);
		const delay = 250 + Math.floor(Math.random() * 1001);
		
		this.#scrollDownNudgeTimer = window.setTimeout(() => {
			this.#scrollDownNudgeTimer = null;
			
			if (!view.isConnected) {
				return;
			}
			
			const deltaY = 100;
			view.dispatchEvent(new WheelEvent("wheel", {
				bubbles: true,
				cancelable: true,
				deltaY,
				deltaMode: WheelEvent.DOM_DELTA_PIXEL
			}));
			
			// Synthetic wheel events do not perform the browser's default scroll action,
			// so mirror a single downward wheel step for the Discord message scroller.
			view.scrollTop += deltaY;
		}, delay);
	}
	
	static getMessagesFromSelectedChannel() {
		const channelId = this.#getCurrentlySelectedChannelId();
		return channelId ? this.#getMessages(channelId) : null;
	}
	
	/**
	 * Calls the provided function with a list of messages whenever the currently loaded messages change.
	 * @param callback {function(server: ?DiscordGuild, channel: DiscordChannel, messages: Array<DiscordMessage>, hasMoreBefore: boolean)}
	 */
	static setupMessageCallback(callback) {
		const previousMessages = new Set();
		
		const onMessageElementsChanged = force => {
			const messages = this.getMessagesFromSelectedChannel();
			if (!messages || !messages.ready || messages.loadingMore) {
				return false;
			}
			
			const channel = this.#channelStore.getChannel(messages.channelId);
			if (!channel) {
				return false;
			}
			
			const hasChanged = force || !messages.hasMoreBefore || messages.some(message => !previousMessages.has(message.id));
			if (!hasChanged) {
				return false;
			}
			
			previousMessages.clear();
			for (const message of messages._array) {
				previousMessages.add(message.id);
			}
			
			const server = this.#guildStore.getGuild(channel.guild_id);
			
			callback(server, channel, messages._array, messages.hasMoreBefore);
			return true;
		};
		
		let debounceTimer;
		
		/**
		 * Do not trigger the callback too often due to autoscrolling.
		 */
		const onMessageElementsChangedLater = function() {
			window.clearTimeout(debounceTimer);
			debounceTimer = window.setTimeout(onMessageElementsChanged, 100);
		};
		
		const observer = new MutationObserver(function() {
			onMessageElementsChangedLater();
		});
		
		let skipsLeft = 0;
		let observedElement = null;
		
		const observerTimer = window.setInterval(() => {
			if (skipsLeft > 0) {
				--skipsLeft;
				return;
			}
			
			const view = this.getMessageOuterElement();
			
			if (!view) {
				skipsLeft = 1;
				return;
			}
			
			if (observedElement !== null && observedElement.isConnected) {
				return;
			}
			
			observedElement = view.querySelector("[data-list-id='chat-messages']");
			
			if (observedElement) {
				console.debug("[DHT] Observed message container.");
				observer.observe(observedElement, { childList: true });
				onMessageElementsChangedLater();
			}
		}, 400);
		
		window.DHT_ON_UNLOAD.push(() => {
			observer.disconnect();
			observedElement = null;
			window.clearInterval(observerTimer);
		});
		
		return () => onMessageElementsChanged(true);
	}
	
	/**
	 * Selects the next text channel and returns true, otherwise returns false if there are no more channels.
	 */
	static async selectNextTextChannel() {
		let currentChannel = this.getSelectedChannel();
		if (!currentChannel) return false;
		if (this.CHANNEL_TYPE.isPrivate(currentChannel.type)) {
			const privateChannels = this.#channelStore.getSortedPrivateChannels();
			const currentIndex = privateChannels.findIndex(channel => channel.id === currentChannel.id);
			if (currentIndex === -1 || currentIndex === privateChannels.length - 1) return false;
			this.#selectPrivateChannel(privateChannels[currentIndex + 1].id);
			return true;
		}
		if (this.CHANNEL_TYPE.isThread(currentChannel.type) && currentChannel.parent_id) {
			const parentChannel = this.#channelStore.getChannel(currentChannel.parent_id);
			if (parentChannel && this.CHANNEL_TYPE.isForum(parentChannel.type)) {
				if (this.#forumParentId === parentChannel.id) {
					if (this.#forumQueue.length > 0) {
						this.#transitionToGuildSync(parentChannel.guild_id, {}, this.#forumQueue.shift());
						return true;
					}
					currentChannel = parentChannel;
				}
				else {
					if (await this.startForumTraversal(parentChannel, currentChannel.id)) return true;
					currentChannel = parentChannel;
				}
			}
		}
		else if (this.CHANNEL_TYPE.isForum(currentChannel.type)) {
			if (await this.startForumTraversal(currentChannel)) return true;
		}
		const guildId = currentChannel.guild_id;
		let isChannelOptedIn;
		if (this.#guildSettings.isOptInEnabled(guildId)) {
			const optedInChannels = this.#guildSettings.getOptedInChannels(guildId);
			isChannelOptedIn = channel => optedInChannels.has(channel.id);
		}
		else isChannelOptedIn = _ => true;
		const guildChannelMap = this.#channelStore.getMutableGuildChannelsForGuild(guildId);
		const guildChannels = Object.values(guildChannelMap)
			.filter(channel => {
				if (!this.CHANNEL_TYPE.isNavigableGuildChannel(channel.type) || !isChannelOptedIn(channel) || !this.#hasPermission(this.PERMISSION.VIEW_CHANNEL, channel)) return false;
				if (this.CHANNEL_TYPE.isThread(channel.type) && channel.parent_id) {
					const parent = this.#channelStore.getChannel(channel.parent_id);
					if (parent && this.CHANNEL_TYPE.isForum(parent.type)) return false;
				}
				return true;
			})
			.sort((a,b)=>(a.position ?? Number.MAX_SAFE_INTEGER)-(b.position ?? Number.MAX_SAFE_INTEGER));
		const currentIndex = guildChannels.findIndex(channel => channel.id === currentChannel.id);
		if (currentIndex === -1) return false;
		for (let i = currentIndex + 1; i < guildChannels.length; i++) {
			const nextChannel = guildChannels[i];
			if (this.CHANNEL_TYPE.isForum(nextChannel.type)) {
				if (await this.startForumTraversal(nextChannel)) return true;
				continue;
			}
			this.#forumQueue = [];
			this.#forumParentId = null;
			this.#forumThreadPositions.clear();
			this.#transitionToGuildSync(guildId, {}, nextChannel.id);
			return true;
		}
		return false;
	}
}