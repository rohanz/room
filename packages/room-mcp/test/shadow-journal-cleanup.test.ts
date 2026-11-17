import { shadowFailureMatrix } from './shadow-failure-fixture.js'

shadowFailureMatrix([['journal', 'journal close']], false, process.env.TEST_SCALE === '1')
