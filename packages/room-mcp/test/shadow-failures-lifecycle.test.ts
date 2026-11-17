import { shadowFailureMatrix } from './shadow-failure-fixture.js'

shadowFailureMatrix([
  ['observe', 'observation commit'], ['observe', 'observation pin'], ['observe', 'merge-tree'],
  ['observe', 'left byte recheck'], ['observe', 'right byte recheck'],
  ['keep', 'collection closure'], ['keep', 'delivery commit'], ['refresh', 'refresh closure'],
  ['refresh', 'refresh commit'], ['journal', 'journal append'], ['retire', 'worker cleanup'], ['leave', 'family cleanup'],
], true, process.env.TEST_SCALE === '1')
