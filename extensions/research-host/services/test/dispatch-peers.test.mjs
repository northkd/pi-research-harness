import * as dispatch from '../research-dispatch-service.mjs';
import { dispatchPeerContract } from '../../../../tests/fixtures/dispatch-peer-contract.mjs';
dispatchPeerContract(dispatch, 'host dispatch');
