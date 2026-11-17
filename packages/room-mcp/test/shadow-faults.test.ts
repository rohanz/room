import { shadowFailureMatrix } from './shadow-failure-fixture.js'

// One real pipeline per failure kind. All stage permutations remain in the scale matrix.
shadowFailureMatrix([
  ['spawn', 'spawn closure'], ['keep', 'collection closure'], ['refresh', 'refresh closure'],
], false, false, ['throw', 'reject', 'hang'])
