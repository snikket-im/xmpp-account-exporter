let data_names = {
	"jabber:iq:roster": "Contact list",
	"vcard-temp": "Profile information",
};

// Hard-code BOSH URLs for some servers without XEP-0156 support
let static_service_urls = {
	"blabber.im": "https://blabber.im/http-bind",
	"libre-chat.net": "https://libre-chat.net:5280/bosh",
	"snopyta.org": "https://xmpp.snopyta.org/http-bind"
};

function setServiceUrl(_converse, service_url) {
	if(service_url.startsWith("wss:")) {
		_converse.api.settings.set("websocket_url", service_url);
	} else {
		_converse.api.settings.set("bosh_service_url", service_url);
	}
	sessionStorage.setItem('account-migrator-service-url', service_url);
}

function fetchRoster(_converse, env) {
	return new Promise(function(resolve, reject) {
		let rosterRequest = env.$iq({
				type: "get"
			})
			.c("query", {
				xmlns: "jabber:iq:roster"
			});
		let id = _converse.connection.sendIQ(rosterRequest,
			(stanza) => resolve(env.sizzle("iq>query", stanza)[0]),
			(err) => reject(err)
		);
		console.log("Fetching roster with id " + id);
		if (!id) {
			reject("no id");
		}
	});
}

function uploadRoster(_converse, env, roster, notify) {
	console.log("Uploading roster...")
	let {
		Strophe,
		$iq,
		$pres
	} = env;
	return new Promise(function(resolve, reject) {
		Strophe.forEachChild(roster, "item", (roster_item) => {
			let contact_jid = roster_item.getAttribute("jid");
			let old_sub_state = roster_item.getAttribute("subscription");
			if (notify) {
				if (old_sub_state == "both" || old_sub_state == "from") {
					// We had an incoming 
					let preapproval = $pres({
						to: contact_jid,
						type: "subscribed"
					});
					_converse.connection.send(preapproval);
				}
				if (old_sub_state == "both" || old_sub_state == "to") {
					// We had an outgoing
					let sub = $pres({
						to: roster_item.getAttribute("jid"),
						type: "subscribe"
					});
					_converse.connection.send(sub);
				}
			} else {
				// No subscription requests/approvals, only add roster entry
				let roster_add = $iq({
						type: "set",
						id: "import-contact"
					})
					.c("query", {
						xmlns: "jabber:iq:roster"
					})
					.c("item", {
						jid: contact_jid
					});
				_converse.connection.send(roster_add);
			}
		});
		resolve("jabber:iq:roster");
	});
}

function uploadVCard(_converse, env, vCard) {
	console.log("Uploading vCard...");
	return new Promise(function(resolve, reject) {
		let request = env.$iq({
				type: "set"
			})
			.cnode(vCard);
		_converse.connection.sendIQ(request,
			(result) => resolve("vcard-temp"),
			(err) => reject(err)
		);
	});
}

function fetchVCard(_converse, env) {
	return new Promise(function(resolve, reject) {
		let rosterRequest = env.$iq({
				type: "get"
			})
			.c("vCard", {
				xmlns: "vcard-temp"
			});
		_converse.connection.sendIQ(rosterRequest,
			(stanza) => resolve(env.sizzle("iq>vCard", stanza)[0]),
			(err) => {
				let errName = err.querySelector("error :first-child").nodeName;
				reject(errName);
			}
		);
	});
}

function fetchData(_converse, env) {
	console.log("Fetching data...");
	return Promise.allSettled([
		fetchRoster(_converse, env),
		fetchVCard(_converse, env),
	]);
}

const NS = {
    xrd: 'http://docs.oasis-open.org/ns/xri/xrd-1.0',
    roster: 'jabber:iq:roster',
    disco_items: 'http://jabber.org/protocol/disco#items',
    disco_info: 'http://jabber.org/protocol/disco#info',
    dataforms: 'jabber:x:data',
    pubsub: 'http://jabber.org/protocol/pubsub',
    pubsub_owner: 'http://jabber.org/protocol/pubsub#owner',
    avatar_metadata: 'urn:xmpp:avatar:metadata',
    avatar_data: 'urn:xmpp:avatar:data',
    nickname: 'http://jabber.org/protocol/nick',
    vcard4: 'urn:ietf:params:xml:ns:vcard-4.0',
    mam: 'urn:xmpp:mam:2',
    forward: 'urn:xmpp:forward:0',
};

function nsResolver(prefix) {
    return NS[prefix] || null;
}

function parseXPath(elem, xpath, result)
{
    if (result === undefined)
        result = XPathResult.FIRST_ORDERED_NODE_TYPE;
    const value = elem.getRootNode().evaluate(xpath, elem, nsResolver, result, null);
    if (result == XPathResult.FIRST_ORDERED_NODE_TYPE)
        return value.singleNodeValue;
    return value;
}

function getServiceURL(jid) {
	const [nodepart, domainpart] = jid.split('@', 2);
	if(static_service_urls.hasOwnProperty(domainpart)) {
		return Promise.resolve(static_service_urls[domainpart]);
	}

	let xrdPromise = new Promise((resolve, reject) => {
		const url = 'https://' + domainpart + '/.well-known/host-meta';
		const xhr = new XMLHttpRequest();
		xhr.onabort = reject;
		xhr.onerror = reject;
		xhr.overrideMimeType("text/xml");
		xhr.onload = function(evt) {
			if(evt.target.status != 200) {
				reject();
				return;
			}
			const xml = evt.target.responseXML;
			if(!xml) {
				reject();
				return;
			}
			const links = parseXPath(xml, './xrd:XRD/xrd:Link', XPathResult.ORDERED_NODE_ITERATOR_TYPE);
			let bosh_service = null;
			let ws_service = null;
			while (true) {
				const link = links.iterateNext();
				if (!link)
					break;
				const rel = link.getAttributeNS(null, 'rel');
				if (rel == 'urn:xmpp:alt-connections:xbosh')
					bosh_service = link.getAttributeNS(null, 'href');
				else if (rel == 'urn:xmpp:alt-connections:websocket')
					ws_service = link.getAttributeNS(null, 'href');
			}
			if(ws_service || bosh_service) {
				console.log('bosh_service', bosh_service);
				console.log('ws_service', ws_service);
				resolve(ws_service || bosh_service);
			} else {
				reject();
			}
		};
		xhr.open('GET', url);
		xhr.send();
	});
	let jrdPromise = new Promise((resolve, reject) => {
		const url = 'https://' + domainpart + '/.well-known/host-meta.json';
		const xhr = new XMLHttpRequest();
		xhr.onabort = reject;
		xhr.onerror = reject;
		xhr.overrideMimeType("application/json");
		xhr.onload = function(evt) {
			if(evt.target.status != 200) {
				reject();
				return;
			}
			let jrd = null;
			switch(evt.target.responseType) {
				case "json":
					jrd = evt.target.response;
					break;
				case "": // "An empty responseType string is the same as "text", the default type."
				case "text":
					jrd = JSON.parse(evt.target.response);
					break;
				default:
					return reject();
			}

			let bosh_service = null;
			let ws_service = null;

			if(jrd.links) {
				for(link of jrd.links) {
					if (link.rel == 'urn:xmpp:alt-connections:xbosh')
						bosh_service = link.href;
					else if (link.rel == 'urn:xmpp:alt-connections:websocket')
						ws_service = link.href;
				}
			}
			if(ws_service || bosh_service) {
				console.log('bosh_service', bosh_service);
				console.log('ws_service', ws_service);
				resolve(ws_service || bosh_service);
			} else {
				reject();
			}
		};
		xhr.open('GET', url);
		xhr.send();
	});
	return Promise.any([xrdPromise, jrdPromise]).catch(function (err) {
		// If we wanted a fallback, here is a good place to return it
		throw "XEP-0156 lookup failed.";
	});
}

window.addEventListener('converse-loaded', function(e) {
	let converse = e.detail.converse;

	let {
		Strophe
	} = converse.env;

	var result = null;
	var resultJid = null;
	var migrationAccount = null;
	var migrationStatus = null;

	console.log("Converse loaded!", converse);

	converse.plugins.add('account-migrator', {

		initialize: function() {
			const {
				_converse
			} = this;
			const log = _converse.log;
			const body = document.querySelector('body');
			const logout_form = document.querySelector('form.logout');
			const output_el = document.querySelector('.output');
			const account_management_card = document.getElementById("account-management-card");
			const download_panel = document.querySelector('.download');
			const conn_status_panel = document.querySelector('#connection-status-panel');
			const login_form = document.querySelector('form.login');
			const secondary_login_form = document.querySelector('form.login-secondary');
			const new_account_hint = document.getElementById('new-account-hint')

			login_form.addEventListener('submit', ev => {
				ev.preventDefault();
				const form_data = new FormData(ev.target);
				new_account_hint.style.display = 'none'

				account_management_card.classList.remove("d-none")
				login_form.style.display = 'none';
				logout_form.style.display = 'block';
				hideErrorMessage();

				getServiceURL(form_data.get('jid')).then(
					(service_url) => {
						console.log("Discovered service URL:", service_url);
						setServiceUrl(_converse, service_url);
						setTimeout(
							()=>_converse.api.user.login(form_data.get('jid'), form_data.get('password')),
							0
						);
					},
					(err) => {
						showErrorMessage(
							"Your account is not currently compatible with this service.",
							err || "The chosen server does not advertise any suitable connection methods as described in XEP-0156."
						);
					}
				);
			});

			function updateLoginForm() {
				let connected = _converse.connection && _converse.connection.connected;
				if(connected || migrationStatus != "pending")
					login_form.style.display = connected ? 'none' : 'block';
				logout_form.style.display = connected ? 'block' : 'none';
				download_panel.style.display = (result && result.status == "fulfilled") ? 'block' : 'none';
				conn_status_panel.style.display = connected ? "block" : "none";

				if (connected) {
					document.getElementById("conn-status-text").innerText = "Logged in as " + Strophe.getBareJidFromJid(_converse.connection.jid);
				} else {
					document.getElementById("conn-status-text").innerText = "Disconnected";
				}
			}

			function showStatus() {
				let status_panel = document.getElementById("download-status-panel");
				status_panel.style.display = "block";
			}

			function hideStatus() {
				let status_panel = document.getElementById("download-status-panel");
				status_panel.style.display = "none";
			}

			function showErrorMessage(simple_err, expert_err) {
				console.log("Showing error:", simple_err, expert_err);
				let err_box = document.getElementById("error-alert");
				err_box.querySelector("p").innerText = simple_err;
				err_box.style.display = "block";
				let expert_info_container = err_box.querySelector(".expert-info-container");
				if (expert_err) {
					document.getElementById("expert-info").innerText = expert_err;
					expert_info_container.style.display = "block";
				} else {
					expert_info_container.style.display = "none";
				}
			}

			function hideErrorMessage() {
				let err_box = document.getElementById("error-alert");
				err_box.style.display = "none";
			}

			logout_form.addEventListener('submit', ev => {
				ev.preventDefault();
				migrationStatus = null;
				migrationAccount = null;
				result = null;
				resultJid = null;
				hideErrorMessage();
				_converse.api.user.logout();
			});

			_converse.api.listen.on('disconnected', () => {
				output_el.innerHTML = '';
				updateLoginForm();
				console.log("disconnected");
				if (migrationAccount && migrationStatus == "pending") {
					let service_url = migrationAccount.options.service_url;
					console.log("Migration requested. Logging into new account...");
					setServiceUrl(_converse, service_url);
					setTimeout(
						()=>_converse.api.user.login(migrationAccount.jid, migrationAccount.password),
						0
					);
				}
				let disconnect_feedback = _converse.connfeedback.get("message");
				if (disconnect_feedback) {
					showErrorMessage(disconnect_feedback);
				}
			});
			_converse.api.listen.on('connected', () => {
				output_el.innerHTML = '';
				updateLoginForm();
				console.log("connected");
				if (!result) {
					// Start data fetching
					let jid = _converse.api.user.jid();
					let host = Strophe.getDomainFromJid(jid);
					let username = Strophe.getNodeFromJid(jid);

					resultJid = Strophe.getBareJidFromJid(jid);
					result = fetchData(_converse, converse.env);

					showStatus();
					result.then(hideStatus);

					result.then(function(results) {
						let ok_results = results.filter(result => result.status == "fulfilled");
						if (ok_results.length == 0) {
							throw "no-results";
						}
						return ok_results.map(result => result.value);
					}).catch(function(err) {
						console.log("results failed");
						console.log("Failed to fetch account data:", err);
						showErrorMessage("Failed to export any data.", err);
						_converse.api.user.logout();
						throw (err);
					}).then(function(results) {
						let exported_data_list_el = document.getElementById("exported-data-list");
						exported_data_list_el.innerHTML = "";
						for (element of results) {
							let xmlns = element.getAttribute("xmlns");
							if (data_names.hasOwnProperty(xmlns)) {
								let li = document.createElement("li");
								li.innerText = data_names[xmlns];
								exported_data_list_el.appendChild(li);
							}
						}
						return results;
					}).then(function(results) {
						console.log("results fetched", result);
						return new Blob([].concat(
							[
								"<?xml version='1.0' encoding='UTF-8'?>\n",
								"<server-data xmlns='urn:xmpp:pie:0'>\n",
								"  <host jid='" + Strophe.xmlescape(host) + "'>\n",
								"    <user name='" + Strophe.xmlescape(username) + "'>\n",
							],
							results.map((element) => ("      " + Strophe.serialize(element) + "\n")), [
								"    </user>\n",
								"  </host>\n",
								"</server-data>\n",
							]
						), {
							type: "application/xpie+xml"
						});
					}).then(blob => {
						let a = document.getElementById("download-button");
						a.setAttribute("href", URL.createObjectURL(blob));
						a.setAttribute("download", "account-data.xml");
						document.getElementById("exported-jid").innerText = resultJid;
						download_panel.style.display = 'block';
						return blob;
					});

					result.then(function(results) {
						secondary_login_form.addEventListener("submit", function(ev) {
							ev.preventDefault();
							const form_data = new FormData(ev.target);

							let modal = bootstrap.Modal.getInstance(document.getElementById("migrate-modal"));

							getServiceURL(form_data.get("jid")).then(function (service_url) {
								ev.target.style.display = 'none';

								migrationStatus = "pending";
								migrationAccount = {
									jid: form_data.get("jid"),
									password: form_data.get("password"),
									options: {
										notify_contacts: form_data.has("notify-contacts"),
										service_url: service_url,
									},
								};
								console.log("Logging out of first account...");
								_converse.api.user.logout();
								modal.hide();
							}).catch(function (err) {
								showErrorMessage("Failed to connect to new account", err);
								modal.hide();
							});

						});
					});
				} else if (migrationStatus == "pending") {
					console.log("Second account connected ok");
					result.then(function(results) {
						console.log("Starting migration...");
						let uploadResults = [];
						for (result of results.filter(result => result.status == "fulfilled")) {
							let element = result.value;
							switch (element.getAttribute("xmlns")) {
								case "jabber:iq:roster":
									let rosterPromise = uploadRoster(_converse, converse.env, element, migrationAccount.options.notify_contacts);
									uploadResults.push(rosterPromise.catch(err=>Promise.reject("jabber:iq:roster")));
									break;
								case "vcard-temp":
									let vCardPromise = uploadVCard(_converse, converse.env, element);
									uploadResults.push(vCardPromise.catch(err=>Promise.reject("vcard-temp")));
									break;
							}
						}
						return Promise.allSettled(uploadResults);
					}).then(function(uploadResults) {
						let okUploads = uploadResults
							.filter(result=>result.status=="fulfilled")
							.map(result=>result.value);
						let failedUploads = uploadResults
							.filter(result=>result.status=="rejected")
							.map(result=>result.reason);
						console.log("Migration complete ("+ okUploads.length + "/" + uploadResults.length + " ok)");
						if(okUploads.length > 0) {
							document.getElementById("migration-status-success").style.display = "block";
							document.getElementById("migrate-button").style.display = "none";
							download_panel.style.display = "block";
						} else {
							showErrorMessage("Account migration failed.");
						}
						if(failedUploads.length > 0) {
							document.getElementById("migration-status-warning").style.display = "block";
							let failedMigrationList = document.getElementById("migration-failure-list");
							failedMigrationList.innerHTML = "";
							for (xmlns of failedUploads) {
								if (data_names.hasOwnProperty(xmlns)) {
									let li = document.createElement("li");
									li.innerText = data_names[xmlns];
									failedMigrationList.appendChild(li);
								}
							}
						}
					});
				}
			});

			_converse.api.listen.on('connectionInitialized', () => {

				updateLoginForm();

				console.log("connected!", _converse.connection.connected, _converse, "and", converse);

				const xmlInput = _converse.connection.xmlInput;
				const xmlOutput = _converse.connection.xmlOutput;

				_converse.connection.xmlInput = function(body) {
					const el = document.createElement('code');
					el.className = "d-block pt-2 pb-2 border-top";
					el.textContent = body.outerHTML;
					output_el.insertAdjacentElement('beforeend', el);
					xmlInput.apply(this, arguments);
				};
				_converse.connection.xmlOutput = function(body) {
					const el = document.createElement('code');
					el.className = "d-block pt-2 pb-2 border-top";
					el.textContent = body.outerHTML;
					output_el.insertAdjacentElement('beforeend', el);
					xmlOutput.apply(this, arguments);
				};


			});
		}
	});

	converse.initialize({
		// Provide a dummy BOSH URL (it's not expected to work, but
		// Converse.js won't initialize without one. We later discover
		// it dynamically and update before we call login().
		bosh_service_url: sessionStorage.getItem('account-migrator-service-url') || "https://localhost:5281/http-bind",

		authentication: 'login',
		auto_reconnect: false,
		persistent_store: 'sessionStorage',
		discover_connection_methods: false,
		whitelisted_plugins: ['account-migrator'],
		blacklisted_plugins: [
			'converse-vcard',
			'converse-muc',
			'converse-bookmarks',
			'converse-carbons',
		],
		priority: -1,
		debug: true
	});

});
