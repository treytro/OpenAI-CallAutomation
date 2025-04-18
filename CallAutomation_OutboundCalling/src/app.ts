import { config } from 'dotenv';
import fs from "fs";
import sanitize from "sanitize-filename";
import express, { Application } from 'express';
import { PhoneNumberIdentifier } from "@azure/communication-common";
import {  } from "@azure/communication-common";
import {
	CallAutomationClient, 
	CallConnection,
	CallMediaRecognizeChoiceOptions,
	RecognitionChoice,
	TextSource, 
	CallInvite,	
	CreateCallOptions,
	CallMedia,
	DtmfTone } from "@azure/communication-call-automation";
import path from 'path';

config();

const PORT = process.env.PORT;
const app: Application = express();
app.use(express.static('webpage'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

let callConnectionId: string;
let callConnection: CallConnection;
let serverCallId: string;
let callee: PhoneNumberIdentifier;
let acsClient: CallAutomationClient;

const mainMenu = ` Hello this is Contoso Bank, we’re calling in regard to your appointment tomorrow 
at 9am to open a new account. Please say confirm if this time is still suitable for you or say cancel if you would like to cancel this appointment.`;
const confirmText = `Thank you for confirming your appointment tomorrow at 9am, we look forward to meeting with you.`;
const cancelText = `Your appointment tomorrow at 9am has been cancelled. Please call the bank directly 
if you would like to rebook for another date and time.`;
const customerQueryTimeout = `I’m sorry I didn’t receive a response, please try again.`;
const noResponse = `I didn't receive an input, we will go ahead and confirm your appointment. Goodbye`
const invalidAudio = `I’m sorry, I didn’t understand your response, please try again.`;
const confirmLabel = `Confirm`;
const cancelLabel = `Cancel`;
const retryContext = `Retry`;

async function createAcsClient() {
	const connectionString = process.env.CONNECTION_STRING || "";
	acsClient = new CallAutomationClient(connectionString);
	console.log("Initialized ACS Client.");
}

async function createOutboundCall() {
	const callInvite: CallInvite = {
		targetParticipant: callee,
		sourceCallIdNumber: {
			phoneNumber: process.env.ACS_RESOURCE_PHONE_NUMBER || "",
		},
	};

	const options: CreateCallOptions ={ callIntelligenceOptions: { cognitiveServicesEndpoint: process.env.COGNITIVE_SERVICES_ENDPOINT } };
	console.log("Placing outbound call...");
	acsClient.createCall(callInvite, process.env.CALLBACK_URI + "/api/callbacks", options);
}

async function handlePlay(callConnectionMedia:CallMedia, textContent:string){
	const play : TextSource = { text:textContent , voiceName: "en-US-NancyNeural", kind: "textSource"}
	await callConnectionMedia.playToAll([play]);
}

async function getChoices(){
	const choices: RecognitionChoice[] = [ 
		{  
			label: confirmLabel, 
			phrases: [ "Confirm", "First", "One" ], 
			tone: DtmfTone.One 
		}, 
		{ 
			label: cancelLabel, 
			phrases: [ "Cancel", "Second", "Two" ], 
			tone: DtmfTone.Two 
		} 
	]; 

	return choices;
}

async function startRecognizing(callMedia: CallMedia, textToPlay: string, context: string){
	const playSource: TextSource = { text: textToPlay, voiceName: "en-US-NancyNeural", kind: "textSource" }; 

	const recognizeOptions: CallMediaRecognizeChoiceOptions = { 
		choices: await getChoices(), 
		interruptPrompt: false, 
		initialSilenceTimeoutInSeconds: 10, 
		playPrompt: playSource, 
		operationContext: context, 
		kind: "callMediaRecognizeChoiceOptions"
	}; 

	await callMedia.startRecognizing(callee, recognizeOptions)
}

async function hangUpCall() {
	callConnection.hangUp(true);
}

// POST endpoint to handle ongoing call events
app.post("/api/callbacks", async (req: any, res: any) => {
	const event = req.body[0];
	const eventData = event.data;
	callConnectionId = eventData.callConnectionId;
	serverCallId = eventData.serverCallId;
	console.log("Call back event received, callConnectionId=%s, serverCallId=%s, eventType=%s", callConnectionId, serverCallId, event.type);
	callConnection = acsClient.getCallConnection(callConnectionId);
	const callMedia = callConnection.getCallMedia();
	if (event.type === "Microsoft.Communication.CallConnected") {
		// (Optional) Add a Microsoft Teams user to the call.  Uncomment the below snippet to enable Teams Interop scenario.
		// await acsClient.getCallConnection(callConnectionId).addParticipant({
		// 	targetParticipant: { microsoftTeamsUserId: process.env.TARGET_TEAMS_USER_ID },
		// 	sourceDisplayName: "Jack (Contoso Tech Support)"
		// });

		console.log("Received CallConnected event");
		await startRecognizing(callMedia, mainMenu, "");
	}
	else if (event.type === "Microsoft.Communication.RecognizeCompleted") {
		if(eventData.recognitionType === "choices"){
			var context = eventData.operationContext;
			const labelDetected = eventData.choiceResult.label; 
        	const phraseDetected = eventData.choiceResult.recognizedPhrase;
        	console.log("Recognition completed, labelDetected=%s, phraseDetected=%s, context=%s", labelDetected, phraseDetected, eventData.operationContext);
			const textToPlay = labelDetected === confirmLabel ? confirmText : cancelText;			
			await handlePlay(callMedia, textToPlay);
		}
	} 
	else if (event.type === "Microsoft.Communication.RecognizeFailed") {
		var context = eventData.operationContext;
		if(context !== "" && (context === retryContext)){
			await handlePlay(callMedia, noResponse);
		}
		else{
			const resultInformation = eventData.resultInformation
			var code = resultInformation.subCode;
			console.log("Recognize failed: data=%s", JSON.stringify(eventData, null, 2));

			let replyText = '';
			switch(code){
				case 8510:
				case 8511:
					replyText = customerQueryTimeout;
					break;
				case 8534:
				case 8547:
					replyText = invalidAudio
					break;
				default:
					replyText = customerQueryTimeout;
			}

			await startRecognizing(callMedia, replyText, retryContext);
		}
	}
	else if (event.type === "Microsoft.Communication.PlayCompleted" || event.type === "Microsoft.Communication.playFailed") {
		console.log("Terminating call.");
		hangUpCall();
	} 
	
	res.sendStatus(200);
});

// GET endpoint to serve the audio file
app.get("/audioprompt/:filename", (req, res) => {
	const filename = req.params.filename;
	const sanitizedFilename = sanitize(filename);

	try {
		const audioFilePath = fs.realpathSync(path.join(process.env.BASE_MEDIA_PATH || "", sanitizedFilename));

		// Read the audio file
		fs.readFile(audioFilePath, (err, data) => {
			if (err) {
				console.error("Failed to read audio file:", err);
				res.status(500).send("Internal Server Error");
				return;
			}

			// Set the appropriate response headers
			res.set("Content-Type", "audio/wav");
			res.set("Content-Length", data.length.toString());
			res.set("Cache-Control", "no-cache, no-store");
			res.set("Pragma", "no-cache");

			// Send the audio file as the response
			res.send(data);
		});
	} catch (err) {
		console.error("Failed to find audio file: ", err);
		res.status(500).send("Internal Server Error");
	}
});

// GET endpoint to serve the webpage
app.get('/', (req, res) => {
	res.sendFile('index.html', { root: 'src/webpage' });
});

// GET endpoint to place phone call
app.get('/outboundCall', async (req, res) => {
	callee = {
		phoneNumber: process.env.TARGET_PHONE_NUMBER || "",
	};

	await createOutboundCall();
	res.redirect('/');
});

// Start the server
app.listen(PORT, async () => {
	console.log(`Server is listening on port ${PORT}`);
	await createAcsClient();
});
