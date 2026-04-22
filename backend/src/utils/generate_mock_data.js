/**
 * Generate Mock Data — Deprecated wrapper
 *
 * ⚠️ DEPRECATED: This file is a thin compatibility wrapper.
 * The primary data initialization script is: scripts/seed_data.js
 * The calculation utilities live in: utils/solarCalc.js
 *
 * This module re-exports solarCalc functions for backward compatibility
 * with any code that previously imported from here.
 *
 * Usage:
 *   // For data seeding (preferred):
 *   cd backend && node scripts/seed_data.js
 *
 *   // For calculation functions (preferred):
 *   const solarCalc = require('./utils/solarCalc');
 *
 *   // For backward compatibility (still works):
 *   const { generateMockData, getIrradiance, ... } = require('./utils/generate_mock_data');
 */

const solarCalc = require('./solarCalc');

// Re-export all calculation functions for backward compatibility
const {
  getIrradiance,
  getTemperature,
  getWindSpeed,
  randomNoise,
  calculateStringPower,
  calculateVI,
} = solarCalc;

/**
 * @deprecated Use `node scripts/seed_data.js` instead.
 * This wrapper delegates to seed_data.js for the actual seeding work.
 */
function generateMockData() {
  console.log('⚠️  generateMockData() is deprecated. Use `node scripts/seed_data.js` instead.');
  console.log('   Redirecting to seed_data.js...\n');

  // Use child process to run seed_data.js so it gets its own DB connection
  const { execSync } = require('child_process');
  const path = require('path');
  const seedPath = path.join(__dirname, '..', '..', 'scripts', 'seed_data.js');

  try {
    const output = execSync(`node "${seedPath}"`, { stdio: 'inherit' });
    console.log('\n✅ Seed data generation complete.');
  } catch (err) {
    console.error('❌ Seed data generation failed:', err.message);
    process.exit(1);
  }
}

// Run if called directly — redirect to seed_data.js
if (require.main === module) {
  generateMockData();
}

module.exports = {
  generateMockData,
  // Re-exported calculation functions (backward compatibility)
  getIrradiance,
  getTemperature,
  getWindSpeed,
  randomNoise,
  calculateStringPower,
  calculateVI,
};
