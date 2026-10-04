// Everything that names the site lives here.
export const SITE = {
	name: 'Yapa',
	description: 'Lo que viene de más con cada proyecto.',
	author: 'Augusto Vivaldelli',
	github: 'https://github.com/BaldrVivaldelli',
	x: 'https://x.com/AugVivaldelli',
};

// Set by GitHub Actions; empty in a local build, which then shows no source links.
export const REPO = process.env.GITHUB_REPOSITORY ?? '';
export const BRANCH = process.env.GITHUB_REF_NAME ?? 'main';
