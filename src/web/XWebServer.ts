/*
 AIME Web Server
 Author       : Tamir Fridman
 Date Created : 18/05/2022
 Copyright AIME Web3 Technologies, all right reserved

 This is a web server for AIME Metaverse
 
 */



import path from "path"
import fs from "fs"
import { _x, _xlog, _xu, XCommand } from "../Xpell.js"
import _settings from "../utils/aime-settings.js"
import axios from 'axios';

//import {fileURLToPath} from 'url';

//  const __filename = fileURLToPath(import.meta.url);

// const __dirname = path.dirname(__filename);

import express from 'express'
import enforce from 'express-sslify'


import cors from 'cors'

import https from 'https'
import http from 'http'
import * as WebSocket from 'ws';
import multer from "multer"
import passport from 'passport'
import { Strategy as FacebookStrategy } from 'passport-facebook';
import fetch from 'node-fetch';
import session from 'express-session';


const WORMHOLE_DEFAULTS = {
    onconnect: ""
}

// import {Metadata,VALID_SIGNATURE_TOLERANCE_INTERVAL_MS} from "./routers/dcl.js"

import { WormholesServer } from "./womrholes-server.js"
import { XResponse } from "../Xprotocol/XProtocol.js"
import { AimeCDNserver, CDNDataItem } from "../CDN/cdn-server.js"
import UtilsManager from "../modules/aime-utils-manager.js"
import WormholeClient, { WormholeClientInstance } from "./wormholes-client.js"
import { TwitterApi, UserOwnedListsV2Paginator } from "twitter-api-v2"
import Xmanager from "../modules/x-manager.js"
import { jwtDecode } from "jwt-decode"
import LinkedInManager from "../modules/linkedin-manager.js"
import { auth } from "googleapis/build/src/apis/abusiveexperiencereport/index.js"
import TelegramBot from "node-telegram-bot-api"
import TelegramManagerIn, { TelegramManager } from "../modules/telegram-menager.js"
import FacebookWebhookManager from "../modules/facebook-webhook-manager.js"
import { dir } from "console";
import FacebookManager from "../modules/facebook-manager.js";
import WhatsAppManager from "../modules/whatsapp-manager.js";
import ChannelManager from "../managers/channel-manager.js";


let SUPER_USER_KEY = (process.env.SUPER_USER_KEY) ? process.env.SUPER_USER_KEY : ""
let env = (process.env.ENV_NAME) ? process.env.ENV_NAME : "local"
const _cdn_suffix = "@" + env.toLowerCase()
// const REDIRECT_URI = (process.env.REDIRECT_URI) ? process.env.REDIRECT_URI : "No Name"
const SCOPE = (process.env.SCOPE) ? process.env.SCOPE : "No Name"
const redirect = (process.env.CDN_URL) ? process.env.CDN_URL : "No Name"
const ENV_NAME = (process.env.ENV_NAME) ? process.env.ENV_NAME : "local"
const DOMAIN = (process.env.DOMAIN) ? process.env.DOMAIN : "No Name"
const NGROK = (process.env.NGROK) ? process.env.NGROK : "No Name"
const dynamic = express.Router();


type cdnDataType = {
    _id: string,
    _d: number,
    _uname?: string,
    _file: string,
    // _encoding: string,
    _mime_type: string,
    _size: number
}

const _multer_storage = multer.diskStorage({
    destination: (req, file, cb) => {

        const cdnFolder = './data/audio'
        // fs.mkdirSync(cdnFolder)
        cb(null, cdnFolder);
    },
    filename: (req, file, cb) => {
        //const fileExtension = file.originalname.split(".").pop();

        // const fileExtension = file.mimetype.split('/')[1];
        let fname = file.originalname

        if (fname == "blob") {
            fname = _xu.guid() + ".mp3"
        }
        cb(null, fname);
    }
});

const _multer_uploader = multer({ storage: _multer_storage });

const _cdn_multer_storage = multer.diskStorage({
    destination: (req: any, file, cb) => {
        req["_id"] = _xu.guid()
        const cdnFolder = './data/cdn/' + req["_id"] + _cdn_suffix;
        fs.mkdirSync(cdnFolder)
        cb(null, cdnFolder);
    },
    filename: (req, file, cb) => {
        // const fileExtension = file.originalname.split(".").pop();

        // const fileExtension = file.mimetype.split('/')[1];
        cb(null, file.originalname);
    }
});

const _cdn_multer_uploader = multer({ storage: _cdn_multer_storage });




class XWebServer {
    baseFolder: string;
    publicFolder: string;
    webSettings: { domain: string; "http-port": number; "enable-ssl": string; "enable-wormhole": string; "ssl-settings": { "https-port": number; "ssl-pk-file": string; "ssl-cert-file": string; "ssl-chain-file": string; }; };

    webServer: http.Server | undefined;
    securedWebServer: https.Server | undefined;
    wormholesServer: typeof WormholesServer
    wormholeClient: typeof WormholeClient
    // wws: Server;
    app: any;
    wormholesSettings: { enable: boolean }
    webSocketServer: WebSocket.WebSocketServer | undefined
    assetsFolder: string
    dashboardAssetsFolder: string
    //wss: any;


    constructor() {

        this.baseFolder = "./XPServer/";
        this.publicFolder = path.resolve('public')
        this.assetsFolder = path.resolve('public/assets')
        this.dashboardAssetsFolder = path.resolve('public/dashboard/assets')

        this.webSettings = _settings.data["web-server"];
        this.wormholesSettings = {
            enable: true
        }
        this.wormholesServer = WormholesServer
        this.wormholeClient = WormholeClient
        // this.wws = null; //wormhole

        this.app = express();
        this.app.use(express.json())
        this.app.use(cors({ origin: true }))
        this.app.locals.appId = 'main-app';
        this.app.use(dynamic)
        // this.exp.use(function(req:any, res:any, next:any) {
        //     res.header('Access-Control-Allow-Origin','*');
        //     res.header('Access-Control-Allow-Headers',"Access-Control-Allow-Headers, Origin,Accept,Authorization, X-Requested-With, Content-Type, Access-Control-Request-Method, Access-Control-Request-Headers");
        //     res.header('Access-Control-Expose-Headers','PAI_SERVER_TIME');
        //     res.header('AIME_SERVER_TIME',(new Date()).getTime()); /** Gets the time value in milliseconds. */
        //     if(req.method === 'OPTIONS') {
        //         res.header('Access-Control-Allow-Methods','GET, POST, PUT, PATCH, DELETE');
        //         return res.status(200).json({});
        //     }

        //         if (c_force_ssl && !req.secure) {
        //             //_logger.log("Redirecting to ssl");
        //             return res.redirect("https://" + req.headers.host + req.url);
        //         }
        //     next();
        // });

        this.checkFolders();

        this.app.use('/public', express.static(this.publicFolder))
        this.app.use('/assets', express.static(this.assetsFolder))
        this.app.use('/dashboard/assets', express.static(this.dashboardAssetsFolder))


        // this.app.use("/users", usersRoute)


        this.app.get("/", this.loadHome)
        this.app.get("/space", this.loadSpace)
        this.app.get("/xspace", this.loadXSpace)
        this.app.get("/web", this.loadWeb)
        this.app.get("/editor", (req: any, res: any) => { this.loadPage("npceditor.html", req, res) })
        this.app.get("/aime-admin", this.loadAdmin)
        this.app.get("/admin-dashboard", this.loadAdminDashboard)
        this.app.get("/aime-agent", this.loadAimeAgent)
        this.app.get("/wordpress-space", this.loadWordpressSpaces)
        this.app.get("/aime-chat", this.loadAimeChat)

        //Facebook

        this.app.use(session({ secret: facebook_client_id, resave: true, saveUninitialized: true }));
        this.app.use(passport.initialize());
        this.app.use(passport.session());

        // Passport session setup
        passport.serializeUser((user, done) => {

            done(null, user);
        });

        passport.deserializeUser((obj: any, done) => {

            done(null, obj);
        });

        //#### facebook_api
        let FACEBOOK_REDIRECT_URI = 'https://1513-213-57-120-90.ngrok-free.app/auth/facebook/callback'

        if (ENV_NAME.toLowerCase() == "local") {
            FACEBOOK_REDIRECT_URI = `${NGROK}/auth/facebook/callback`
        } else {
            if (DOMAIN) {
                FACEBOOK_REDIRECT_URI = `https://${DOMAIN}/auth/facebook/callback`
            }
        }
        //let FACEBOOK_REDIRECT_URI = redirect + 'auth/facebook/callback'
        const CONFIGURATION_ID = "536961332532981"
        passport.use(new FacebookStrategy({
            clientID: facebook_client_id,
            clientSecret: facebook_client_secret,
            callbackURL: FACEBOOK_REDIRECT_URI,

        },
            (accessToken, refreshToken, profile, done) => {

                // done(null, profile);
                return done(null, { profile, accessToken });
            }
        )
        );

        this.app.get('/auth/instagram', (req: any, res: any, next: any) => {
            const _space_id = req.query.state; // Extract _space_id from query params
            req._space_id = _space_id; // Attach _space_id to the req object
            next(); // Pass control to the next middleware
        }, this.authenticateInstagram);

        this.app.get('/auth/facebook', (req: any, res: any, next: any) => {
            const _space_id = req.query.state; // Extract _space_id from query params
            req._space_id = _space_id; // Attach _space_id to the req object
            next(); // Pass control to the next middleware
        }, this.authenticateFacebook);


        this.app.get('/auth/facebook/callback', passport.authenticate('facebook', { failureRedirect: '/auth/facebook/failure' }),
            async (req: any, res: any) => {


                // Successful authentication, redirect home.
                let access_token = req.user.accessToken;

                const state = req.query.state
                if (!state) {
                    return res.status(400).send('State not found');
                }
                else {
                    const url = `https://graph.facebook.com/v19.0/me/accounts?access_token=${access_token}`;
                    let userPagesResponse = await axios.get(url);
                    const userPages = userPagesResponse.data.data;

                    try {
                        let space_id = state.split("xaid")[0];
                        let platform = state.split("xaid")[1];
                        let wid = state.split("xaid")[2]
                        if (platform == "facebook") {
                            for (const pageData of userPages) {
                                if (pageData?.id && pageData?.access_token) {
                                    let cmd = new XCommand()
                                    cmd._params = { _external_id: pageData.id, }
                                    const facebookPage = await ChannelManager._search_channel_page(cmd)
                                    _xlog.debug(facebookPage)
                                    
                                    if (facebookPage._result._result.length == 0) {
                                        // add channel
                                        let facebookchannel = {
                                            _title: pageData.name + " " + platform,
                                            _space_id: space_id,
                                            _url: "https://www.facebook.com/" + pageData.id,
                                            _token: access_token,
                                            _password: "",
                                            _platform: platform,
                                            _external_id: pageData.id,
                                        }
                                        let cmd = new XCommand()
                                         cmd._params = facebookchannel
                                        const channel = await ChannelManager._create_channel(cmd)
                                        _xlog.debug(channel)
                                      

                                        let facebookPageData = {
                                            _channel_id: channel._result._result._id,
                                            _external_id: pageData.id,
                                            _access_token: pageData.access_token,
                                            _title: pageData.name,
                                        }
                                        let cmdP = new XCommand()
                                        cmdP._params = facebookPageData
                                        
                                        
                                    const facebookPage = await ChannelManager._add_channel_page(cmdP)
                                   
                                       _xlog.debug("Facebook page added to channel:", facebookPage)

                                        try {
                                           _xlog.debug("get-history-user-pages-for-user: ", channel._result._result._id)
                                            const historyPost = await _x.execute({
                                                _module: "facebook-manager",
                                                _op: "get-history-user-pages-for-user",
                                                _params: {
                                                    channel_id: channel._result._result._id,
                                                    _wid: wid,
                                                }
                                            })
                                           _xlog.debug("historyPost", historyPost)
                                        }
                                        catch (e) {
                                            _xlog.error("Error adding facebook pages to channel: ", e)
                                        }

                                        FacebookWebhookManager.registerFacebookWebhook(channel._result._result._id, access_token)
                                        res.send('<script>window.close();</script>');

                                        //analze comments
                                        const analytics = await _x.execute({
                                            _module: "facebook-manager",
                                            _op: "analyze-comments-for-all-posts",
                                            _params: {
                                                _channel_id: channel._result._result._id,
                                            }
                                        })

                                        WormholeClient.fireMessage(wid, {
                                            _msg_action: "xem",
                                            _params: {
                                                _event: "facebook-connected",
                                                _data: "Facebook connected"
                                            }
                                        })
                                        break;
                                    }
                                }
                            }
                        } else {

                            if (platform == "instagram") {
                                console.log("enter if platform = instagram")
                                const historyPost = await _x.execute({
                                    _module: "instagram-manager",
                                    _op: "sync-instagram-data",
                                    _params: {
                                        access_token: access_token,
                                        space_id: space_id
                                    }
                                })

                                WormholeClient.fireMessage(wid, {
                                    _msg_action: "xem",
                                    _params: {
                                        _event: "instagram-connected",
                                        _data: "instagram connected"
                                    }
                                })

                                res.send('<script>window.close();</script>');
                            }
                        }                       
                    }
                    catch (e) {
                        console.log(e)
                    }
                }
            });


        this.app.get('/auth/facebook/failure', (req: any, res: any) => {
            res.send("failture")
        }
        );
        //whatsapp
        this.app.get('/whatsapp-hook', async (req: any, res: any) => {
            const VERIFY_TOKEN = "saaritai123"; // must match what you entered in the console

            const mode = req.query['hub.mode'];
            const token = req.query['hub.verify_token'];
            const challenge = req.query['hub.challenge'];

            if (mode === 'subscribe' && token === VERIFY_TOKEN) {
                console.log('WEBHOOK VERIFIED');
                res.status(200).send(challenge);
            } else {
                res.sendStatus(403);
            }

        })

        this.app.post('/whatsapp-hook', async (req: any, res: any) => {
            res.sendStatus(200);

            const handler = await WhatsAppManager.handleMessage(req)

        })

        this.app.get('/onboard/whatsapp/callback', async (req: any, res: any) => {
            const code = req.query.code;

            let state = req.query.state.split("wid=")[1]


            try {
                const token = await WhatsAppManager.exchangeCodeForToken(code)
                const businesses = await WhatsAppManager.getBusinesses(token)

                const wabas = await WhatsAppManager.getClientWABAs(businesses[0]?.id, token)
                // console.log("Token:", token);
                // console.log("Businesses:", businesses);
                // console.log("WABAs:", wabas);

                try {
                    const add_channel = await _x.execute({
                        _module: "entity-manager",
                        _op: "add-dynamic-entity",
                        _params: {
                            _collection_name: "aime-channel",
                            _params: {
                                _title: businesses[0]?.verified_name,
                                _owner_space_id: state,
                                _url: "",
                                _user_id: wabas[0]?.id,
                                _password: token,
                                _platform: "whatsapp",
                            }
                        }
                    })
                } catch (e) {
                    // _xlog.error("Error getting whatsapp businesses: ", e)
                }



                res.send('<script>window.close();</script>');
                WormholeClient.fireMessage(state, {
                    _msg_action: "xem",
                    _params: {
                        _event: "whatsapp-connected",
                        _data: " Whatsapp connected",
                    }
                })


            } catch (error) {
                console.error("❌ Error during WhatsApp onboarding:", error);
                res.status(500).send('Error during WhatsApp onboarding');
            }
        })


        //LinkedIn

        this.app.get('/linkdincb', async (req: any, res: any) => {
            const code = req.query.code;



            if (!code) {
                return res.status(400).send('Authorization code not found');
            }

            try {
                const tokenResponse = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: new URLSearchParams({
                        grant_type: 'authorization_code',
                        code: code,
                        redirect_uri: redirect + 'linkdincb',
                        client_id: linkdin_client_id,
                        client_secret: linkdin_client_secret,
                    }),
                });

                const tokenData: any = await tokenResponse.json();

                const accessToken = tokenData.access_token;


                const decoded = decodeIdToken(tokenData.id_token)

                const sub = decoded.sub;


                let linkdinchannel = {
                    _title: "linkedin",
                    _owner_space_id: req.query.state,
                    _url: "",
                    _user_id: accessToken,
                    _password: sub,
                    _platform: "linkedin",

                }

                let addchannel = await _x.execute({
                    _module: "aime-channel-manager",
                    _op: "add",
                    _params: linkdinchannel
                })


                res.send('<script>window.close();</script>');

                // WormholeClient.fireMessage(wid,{
                //     _msg_action: "xem",
                //     _params: {
                //         _event: "facebook-connected",
                //         _data: "Facebook connected"
                //     }
                // })


            } catch (error) {
                console.error(error);
                res.status(500).send('Error during LinkedIn OAuth');
            }
        });

        function decodeIdToken(idToken: any) {
            const decoded = jwtDecode(idToken);
            console.log('Decoded ID Token:', decoded);
            return decoded;
        }

        //X
        this.app.get('/xauthcb', async (req: any, res: any) => {
            const { oauth_token, oauth_verifier } = req.query;
            // Get the saved oauth_token_secret from session
            const oauth_token_secret = req.session;




            if (!oauth_token || !oauth_verifier || !oauth_token_secret) {
                return res.status(400).send('You denied the app or your session expired!');
            }

            // Obtain the persistent tokens
            // Create a client from temporary tokens

            const client = new TwitterApi({
                appKey: 'XNzffoZ8WVKlBTnNPzbOIF7fy',
                appSecret: 'K4e34Ta3oxpvbYyrDO9m0WHOH660LxyXaYMebSM9zPPrC8S70R',
                accessToken: oauth_token,
                accessSecret: oauth_token_secret,
            });

            client.login(oauth_verifier)
                .then(async ({ client: loggedClient, accessToken, accessSecret }) => {

                    let keys = {
                        appKey: accessToken,
                        appSecret: accessSecret
                    }

                    let data = Xmanager._oauth_wid[oauth_token]
                    console.log(data, "data");





                    if (data) {

                        let xchannel = {
                            _title: data._title,
                            _owner_space_id: data._space_id,
                            _url: "",
                            _user_id: keys.appKey,
                            _password: keys.appSecret,
                            _platform: "x",

                        }

                        let res = await _x.execute({
                            _module: "aime-channel-manager",
                            _op: "add",
                            _params: xchannel
                        })
                        WormholeClient.fireMessage(data._wid, {
                            _msg_action: "xem",
                            _params: {
                                _event: "x-connected",
                                _data: "x connected"
                            }
                        })


                    }
                    if (res) {
                        delete Xmanager._oauth_wid[oauth_token]

                    }


                    res.send('<script>window.close();</script>');



                    // loggedClient is an authenticated client in behalf of some user
                    // Store accessToken & accessSecret somewhere                                
                })
                .catch(() => res.status(403).send('Invalid verifier or access tokens!'));

        });





        //Google blogger


        this.app.get("/oauth/callback", async (req: any, res: any) => {
            const { code } = req.query;
            const state = req.query.state

            if (!code || typeof code !== "string") {
                res.status(400).send("Authorization code is missing or invalid");
                return;
            }

            try {
                // console.log("Received auth code:", code.substring(0, 10) + "...");

                // Handle authentication
                const authCmd = new XCommand();
                authCmd._module = "blogger-manager";
                authCmd._op = "handle_auth_callback";
                const spaceId = state.split("xpell")[0]
                const chanelName = state.split("xpell")[1]
                const wid = state.split("xpell")[2]
                authCmd._params = { code, "_space_id": spaceId, "_channel_name": chanelName };

                const authResult = await _x.execute(authCmd);


                if (authResult._ok) {
                    WormholeClient.fireMessage(wid, {
                        _msg_action: "xem",
                        _params: {
                            _event: "blogger-connected",
                            _data: "blogger connected"
                        }
                    })
                    res.send('<script>window.close();</script>');
                } else {
                    res.status(500).send(authResult._result);
                }

            } catch (error: any) {
                console.error("Authentication error:", error);
                res.status(500).send(`
                <html>
                  <body>
                    <h1>Authentication Failed</h1>
                    <p>Error: ${error.message}</p>
                  </body>
                </html>
              `);
            }
        });

        //OUT 
        this.app.get('/out', async (req: any, res: any) => {
            const targetUrl = req.query.target as string
            const userId = req.query.id as string
            const source = req.query.source as string
            const spaceId = req.query.space as string
            const productId = req.query.productid as string
            const linkName = req.query.linkname as string

            const ip = this.getClientIp(req);
            const userAgent = req.headers['user-agent'];
            if (!targetUrl) {
                return res.status(400).json({ error: 'Missing "to" parameter' })
            }

            // Optional: validate the URL (basic)
            try {
                new URL(targetUrl);
            } catch {
                return res.status(400).json({ error: 'Invalid URL' })
            }

            //Log the click
            let linkClick = {
                _user_id: userId,
                _source: source,
                _original_url: targetUrl,
                _ip_address: ip,
                _user_agent: userAgent,
                _space_id: spaceId,
                _link_name: linkName,
                _aime_product_id: productId
            }
            const r = await _x.execute({
                _module: "entity-manager",
                _op: "add-dynamic-entity",
                _params: {
                    _collection_name: "aime-link-clicks",
                    _params: linkClick
                }
            })

            // Redirect
            res.redirect(targetUrl);
            return res.end();
        });
        //facebook webhook
        // ✅ authenticate webhook
        this.app.get('/facebook-webhook', (req: any, res: any) => {

            const mode = req.query['hub.mode'];
            const token = req.query['hub.verify_token'];
            const challenge = req.query['hub.challenge'];
            // _xlog.log('🔗 Webhook verification request:', { mode, token, challenge });
            if (mode === 'subscribe' && token === 'aime_verify_token') {
                _xlog.debug('✅ FB/Instagram Webhook verified!');
                res.status(200).send(challenge);
            } else {
                _xlog.debug('🔗 FB/Instagram Webhook verification failed');
                res.sendStatus(403);
            }
        });

        // 📩 get Event
        this.app.post('/facebook-webhook', async (req: any, res: any) => {
            _xlog.debug('🔔 FB Messenger Webhook event received');
            // _xlog.debug('📥 Event received:', JSON.stringify(req.body, null, 2));
            await FacebookWebhookManager.handleEvent(req, res);
        });



        //CDN

        this.app.get("/cdn", (req: any, res: any) => {
            const data = fs.readFileSync(this.publicFolder + "/_home.html", 'utf-8')
            res.send(data)
        })

        this.app.use("/upload", (req: any, res: any, next: any) => {
            // console.log("upload",req);

            const data = fs.readFileSync(this.publicFolder + "/_upload.html", 'utf-8')
            res.send(data)
        })



        this.app.post("/add", _cdn_multer_uploader.single("cdn-file"), (req: any, res: any) => {
            try {
                const xres = new XResponse()
                xres._ok = true
                // console.log("req.file",req.file);

                const cdnData: CDNDataItem = {
                    _file: req.file.filename,
                    _d: Date.now(),
                    _l: Date.now(),
                    _h: 0,
                    // _encoding: req.file.encoding,
                    _mime_type: req.file.mimetype,
                    _size: req.file.size,
                    _id: req.file.destination.substr(req.file.destination.lastIndexOf("/") + 1),

                }
                if (req.body['exp']) {
                    const exp = req.body['exp']
                    if (exp == "-1") {
                        cdnData["_exp"] = "-1"
                    } else {
                        try {
                            const newExp = UtilsManager.calculateExpiration(exp)
                            cdnData["_exp"] = newExp.toString()
                        } catch (e) {
                            _xlog.error("Invalid expiration format")
                        }
                    }
                }
                if (req.body['uname']) {
                    cdnData["_uname"] = req.body['uname']
                }
                xres._result = cdnData
                // fs.writeFileSync(req.file.destination + "/" + _cdn_data_file_name, JSON.stringify(cdnData), 'utf-8')


                AimeCDNserver.writeCDNFile(cdnData, req.body['uname'])
                res.json(xres._result)
            } catch (e) {
                _xlog.log("Internal error in cdn add: ", e)
            }

        })


        this.app.use("/get/:_id", (req: any, res: any) => {
            try {
                const _id = req.params._id
                const cdnData = AimeCDNserver.getCdnData(_id)

                // console.log("CDN DATA",cdnData);
                if (cdnData) {
                    res.sendFile(cdnData._file, { root: './data/cdn/' + _id + "/" }, async (err: any) => {
                        if (err) {
                            if (!res.headersSent) {
                                res.status(404).send("File not found");
                            } else {
                                _xlog.log("Error sending file after headers sent:", err);
                            }
                        } else {
                            setTimeout(() => {
                                const expired = AimeCDNserver.checkExp(_id)
                                // console.log("Expired",expired);

                                if (!expired) {
                                    AimeCDNserver.updateLru(_id)
                                }
                            }, 3000);
                        }
                    })

                } else {
                    res.status(404).send("File not found")
                }
            } catch (e) {
                if (!res.headersSent) {
                    res.status(500).send("Internal Server Error");
                }
                _xlog.log("Internal error in CDN get:", e);
            }
        })

        this.app.use("/u/:_uname", (req: any, res: any) => {
            try {
                const uname = req.params["_uname"]
                if (uname && AimeCDNserver._cdn_index[uname]) {
                    res.redirect("/get/" + AimeCDNserver._cdn_index[uname]["_id"])
                } else {
                    res.send("index not found")
                }
            } catch (e) {
                _xlog.error("Internal error in cdn u: ", e)
            }
        })


        this.app.use("/delete/:_id", (req: any, res: any) => {
            try {
                const _id = req.params._id
                const cdnData = AimeCDNserver.getCdnData(_id)
                if (cdnData) {
                    AimeCDNserver.deleteCDNFolder(_id)
                    res.send("File " + cdnData._file + " deleted successfully")
                } else {
                    res.status(404).send("File not found")
                }
            } catch (e) {
                _xlog.error("Internal error in cdn delete: ", e)
            }
        })

        this.app.post("/xcmd", this.authenticateToken, async (req: any, res: any) => {
            try {
                const xcmd = req.body
                const xres = await _x.execute(xcmd)
                res.json(xres)
            } catch (e) {
                _xlog.error("Internal error in xcmd: ", e)
            }
        })

        this.app.post("/get-chat-theme", async (req: any, res: any) => {
            try{
                const spaceId = req.body._space_id;
                const theme = await _x.execute({
                    _module: "xenvironment",
                    _op: "get-chat-theme",
                    _params: {
                        _space_id: spaceId
                    }
                })
                // console.log("Chat theme for space", spaceId, ":", theme);
                res.json(theme._result)
                
            }catch(e){
                _xlog.error("Error getting chat theme: ", e)
                res.status(500).send("Internal Server Error")
            }
        })

        // //dcl router
        // this.app.post(
        //     '/check-validity',
        //     // dclExpress({ expiration: VALID_SIGNATURE_TOLERANCE_INTERVAL_MS }),
        //     async (
        //         req: any|  & dcl.DecentralandSignatureData<Metadata>,
        //         res: any
        //         ) => {
        //             try {


        //                 const user = (req.body)

        //                 if(user && user["id"]) {
        //                     XData.add(user)

        //                 }

        //                 return res.status(200).send({ valid: true, msg: 'Valid request' })
        //             } catch (error) {
        //                 return res
        //                 .status(400)
        //                 .send({ valid: false, error: `Can't validate your request` })
        //             }
        //     }
        // )

        this.app.use("*", (req: any, res: any) => { res.json({ message: "o||o" }) })
        _xlog.log("AIME Web Server is running")
    }


    /**
     * Authenticate aime-token by token and owner id
     * @param req request , headers should contain the token and the owner id
     * @param res 
     * @param next 
     */
    async authenticateToken(req: any, res: any, next: any) {
        const authorization = req.headers['authorization']

        const token = authorization.split(" ")[0]
        const ownerId = authorization.split(" ")[1]

        // console.log("token",token,ownerId);

        const auth = await _x.execute({
            _module: "aime-token-manager",
            _op: "auth-token",
            _params: {
                _t: token,
                _owner_entity_id: ownerId
            }
        })

        if (auth._result._authenticated) {
            next()
        } else {
            res.json({ message: auth._result._error })
        }

    }


    authenticateFacebook(req: any, res: any) {
        const _space_id = req._space_id;

        passport.authenticate('facebook', {
            scope: [
                "pages_read_user_content",
                "pages_read_engagement",
                "pages_manage_metadata",
                "pages_manage_posts",
                "pages_messaging",
                "business_management",
                "pages_show_list"
            ], state: _space_id
        })(req, res);

    }

    authenticateInstagram(req: any, res: any) {
        const _space_id = req._space_id;

        passport.authenticate('facebook', {
            scope: [
                "pages_show_list",
                "pages_read_engagement",
                "instagram_basic",
                "instagram_manage_comments",
                "pages_messaging",
                "instagram_manage_messages",
                "pages_manage_metadata",
                "business_management"
            ], state: _space_id
        })(req, res);

    }


    loadHome(req: any, res: any) {
        // _xlog.log("new web request")
        const data = fs.readFileSync(path.resolve('public') + "/index.html", 'utf-8')
        res.send(data)
    }

    loadSpace(req: any, res: any) {
        // _xlog.log("new web request")


        const data = fs.readFileSync(path.resolve('public') + "/space-page.html", 'utf-8')
        res.send(data)
    }

    loadXSpace(req: any, res: any) {
        // _xlog.log("new web request")


        const data = fs.readFileSync(path.resolve('public') + "/xspace.html", 'utf-8')
        res.send(data)
    }

    loadAdmin(req: any, res: any) {
        const data = fs.readFileSync(path.resolve('public') + "/admin.html", 'utf-8')
        res.send(data)
    }

    loadAdminDashboard(req: any, res: any) {
        const data = fs.readFileSync(path.resolve('public') + "/admin-dashboard.html", 'utf-8')
        res.send(data)
    }

    loadAimeAgent(req: any, res: any) {
        const data = fs.readFileSync(path.resolve('public') + "/aime-agent.html", 'utf-8')
        res.send(data)
    }

    loadAimeChat(req: any, res: any) {
        const data = fs.readFileSync(path.resolve('public') + "/aime-chatbot.html", 'utf-8')
        res.send(data)
    }

    loadWeb(req: any, res: any) {
        // _xlog.log("new web request")
        const data = fs.readFileSync(path.resolve('public') + "/wordpress-frame.html", 'utf-8')
        res.send(data)
    }

    loadPage(pageName: string, req: any, res: any) {
        // _xlog.log("new web request")
        const data = fs.readFileSync(path.resolve('public') + "/" + pageName, 'utf-8')
        res.send(data)
    }
    loadWordpressSpaces(req: any, res: any) {
        // _xlog.log("new web request")
        const data = fs.readFileSync(path.resolve('public') + "/wordpress-space.html", 'utf-8')
        res.send(data)
    }

    async start() {
        let msg = "Starting";
        this.webServer = await http.createServer(this.app).listen(this.webSettings["http-port"], () => {
            msg = "web-server (HTTP) is listening on port " + this.webSettings["http-port"];
            _xlog.log(msg);
            //check if we need to force ssl

        })
        if (this.webSettings["enable-ssl"] === "yes") {
            c_force_ssl = true;
            this.app.use(enforce.HTTPS({ trustProtoHeader: true }));
            const privateKey = fs.readFileSync(this.webSettings["ssl-settings"]["ssl-pk-file"], 'utf8');
            const certificate = fs.readFileSync(this.webSettings["ssl-settings"]["ssl-cert-file"], 'utf8');
            const ca = fs.readFileSync(this.webSettings["ssl-settings"]["ssl-chain-file"], 'utf8');
            const credentials = {
                key: privateKey,
                cert: certificate,
                ca: ca
            };
            try {
                let port = this.webSettings["ssl-settings"]["https-port"];
                _xlog.log("ssl files loaded trying to listen on port " + port);
                this.securedWebServer = https.createServer(credentials, this.app)
                    .listen(port, function () {
                        let lmsg = "web-server is listening with ssl (HTTPS) on port " + port;
                        msg += "\n" + lmsg;
                        _xlog.log("info", lmsg);
                    });
                c_force_ssl = true;

            } catch (e) {
                {
                    let lmsg: string = "ERROR aime-web server ssl cert - " + e;
                    msg += "\n" + lmsg;
                    _xlog.error(lmsg);
                }

            }
        }
        if (this.wormholesSettings.enable) {
            // this.listenWebsocket();
            this.listenWormholes();
        }
        return msg;
    }


    checkFolders() {
        const checkFolder = (folderPath: string) => {
            if (!fs.existsSync(folderPath)) {
                fs.mkdirSync(folderPath, { recursive: true });
                _xlog.log("Creating folder " + folderPath)
            }
        }

        const folders = ["./data", "./data/wormholes", "./data/cdn", "./data/audio", "./data/settings", "./public", "./public/dashboard", "./public/audio", "./public/assets", "./data/xdb", "./public/images"]
        folders.forEach(folder => checkFolder(folder))
        //there are no folders to check :]]
    }

    stop() {

        if (this.webServer) {
            this.webServer.close();
        }
        if (this.securedWebServer) {
            this.securedWebServer.close();
        }

    }


    /**
     * Websocket is managed by Wormholes and the events is being handled by spell 
     * websocket.connect -> spell event -> handled by spell module
     */
    listenWebsocket() {
        if (!this.webSocketServer) {
            let srv = this.webServer
            if (this.securedWebServer) srv = this.securedWebServer

            this.webSocketServer = new WebSocket.WebSocketServer({ server: srv })

            this.webSocketServer.on('connection', (socket: WebSocket, req: any) => {




                const _wid = this.wormholesServer.getWormholeID(req.socket)
                this.wormholesServer.handleConnection(socket, _wid, req)
            })
        }

        _xlog.log('--==|web-server allows wormholes|==--');
    }


    /**
     * Handle incoming connections and open wormholes
     * If the connection is not from a browser(For example: a bot), req.headers.origin will be undefined. Therefore, set 
     * url in headers["agent-client-url"] when connecting to the server.
     * 
     * Send authorization properties to authenticate
     * 
     * @param req req.headers accepts the following headers:
     * 1. client-authorization: "token" "owner entity id"
     * 2. super-user-key: "super user key"
     */
    listenWormholes() {
        if (!this.webSocketServer) {
            let srv = this.webServer
            if (this.securedWebServer) srv = this.securedWebServer

            this.webSocketServer = new WebSocket.WebSocketServer({ server: srv })

            this.webSocketServer.on('connection', (socket: WebSocket, req: any) => {

                let url
                let auth
                let sukey
                if (req.headers.origin) {
                    url = req.headers.origin
                } else if (req.headers["agent-client-url"]) {
                    url = req.headers["agent-client-url"]
                }

                if (req.headers["client-authorization"]) {
                    const clientauth = req.headers["client-authorization"]
                    auth = {
                        _token: clientauth.split(" ")[0],
                        _owner_entity_id: clientauth.split(" ")[1]
                    }
                }

                if (req.headers["super-user-key"] && req.headers["super-user-key"] == SUPER_USER_KEY) {
                    sukey = req.headers["super-user-key"]
                }

                this.wormholeClient.open(url, sukey, null, req.socket, socket, auth)

            })
        }

        _xlog.log('--==|web-server allows wormholes instances|==--');
    }

    /**
     * Register a route with the specified method, path, and handler.
     * @param method The HTTP method (e.g., 'get', 'post', etc.).
     * @param path The path for the route.
     * @param handler The handler function for the route.
     */
    registerRoute({ method, path, handler }: { method: string; path: string; handler: (req: express.Request, res: express.Response, next: express.NextFunction) => void }) {

        if (['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].includes(method)) {
            (dynamic as any)[method](path, handler); // e.g. dynamic.get('/foo', fn)
        } else {
            throw new Error(`Unsupported HTTP method: ${method}`);
        }
    }

    getClientIp(req: any) {
        const xForwardedFor = req.headers['x-forwarded-for'];
        if (typeof xForwardedFor === 'string') {
            return xForwardedFor.split(',')[0].trim(); // לוקח את ה-IP הראשון
        }
        return req.socket.remoteAddress;
    }


}

export default AIMEWebServer;