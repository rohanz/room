import { shadowFailureMatrix } from './shadow-failure-fixture.js'

shadowFailureMatrix([
  ['spawn', 'initialization'], ['spawn', 'spawn closure'],
  ['observe', 'inventory'], ['observe', 'history'], ['observe', 'publication'],
  ['observe', 'HEAD before'], ['observe', 'snapshot'], ['observe', 'snapshot base'],
  ['observe', 'disk read'], ['observe', 'disk stable check'], ['observe', 'HEAD after'],
  ['observe', 'publication base'], ['observe', 'observation tree'],
], false, process.env.TEST_SCALE === '1')
