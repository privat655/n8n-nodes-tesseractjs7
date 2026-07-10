const path = require('path');
const { existsSync } = require('fs');
const { task, src, dest, series } = require('gulp');

task('build:icons', copyIcons);

function copyNodeIcons() {
	const nodeSource = path.resolve('nodes', '**', '*.{png,svg}');
	const nodeDestination = path.resolve('dist', 'nodes');

	return src(nodeSource, { allowEmpty: true }).pipe(dest(nodeDestination));
}

function copyCredentialIcons(done) {
	if (!existsSync(path.resolve('credentials'))) {
		done();
		return;
	}

	const credSource = path.resolve('credentials', '**', '*.{png,svg}');
	const credDestination = path.resolve('dist', 'credentials');

	return src(credSource, { allowEmpty: true }).pipe(dest(credDestination));
}

function copyIcons(done) {
	return series(copyNodeIcons, copyCredentialIcons)(done);
}
