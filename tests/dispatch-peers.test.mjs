import * as dispatch from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-dispatch-service.mjs';
import { dispatchPeerContract } from './fixtures/dispatch-peer-contract.mjs';
dispatchPeerContract(dispatch, 'release dispatch');
