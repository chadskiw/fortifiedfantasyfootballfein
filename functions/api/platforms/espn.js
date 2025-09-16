import { EspnAPI, saveEspnAuth } from './espnClient.js';

// somewhere after you capture SWID/S2 (from your modal/bookmarklet):
saveEspnAuth({ swid: '32307DF3-17F9-4871-A074-9EEE4BCE889F', s2: '<your s2>' });