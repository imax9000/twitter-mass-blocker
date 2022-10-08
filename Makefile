export PATH:=node_modules/.bin:$(PATH)
VERSION := $(shell head -n 1 versions.list)

.PHONY: all tag upload release dummy

all: output

dist/bin/twitter_mass_blocker.zip: dummy
	bazel test //...
	bazel build //:twitter_mass_blocker.zip

dist/bin/updates.json: BUILD.bazel versions.list
	bazel build //:updates.json

output: dist/bin/twitter_mass_blocker.zip
	if [ -d $@ ]; then rm -rf $@/*; else mkdir $@; fi
	bsdtar xvf $< -C $@

web-ext-artifacts/validated-$(VERSION):
	@if [ ! -z "$$(git tag -l v$(VERSION))" ]; then \
		echo "Please update the version number"; exit 1; fi
	@if [ "$$(git status --porcelain=v1 2>/dev/null | wc -l)" -gt 0 ]; then \
		echo "Uncommitted changes detected"; exit 1; fi
	@touch $@

web-ext-artifacts/twitter_mass_blocker-$(VERSION).xpi: | output web-ext-artifacts/validated-$(VERSION)
	source .secrets/web-ext.sh && web-ext sign -s output

upload: dist/bin/updates.json | web-ext-artifacts/twitter_mass_blocker-$(VERSION).xpi
	file="web-ext-artifacts/twitter_mass_blocker-$(VERSION).xpi"; gsutil cp $${file} gs://imax-web-dev/twitter_mass_blocker/$${file##*-}
	gsutil cp dist/bin/updates.json gs://imax-web-dev/twitter_mass_blocker/

tag: web-ext-artifacts/twitter_mass_blocker-$(VERSION).xpi
	git tag v$(VERSION) -m 'Release $(VERSION)'

release: tag upload
