load("@npm//@bazel/typescript:index.bzl", _ts_project = "ts_project")
load("@build_bazel_rules_nodejs//:index.bzl", _js_library = "js_library")

def ts_project(name, **kwargs):
    _ts_project(
        name = name,
        **kwargs
    )

    native.genrule(
        name = name + "_tsconfig_for_vscode",
        outs = ["tsconfig_for_vscode.json"],
        srcs = [
            "tsconfig_sources.json",
        ],
        cmd = "sed -E -e 's,\"../,\",g' $< > $@",
    )
    native.genrule(
        name = name + "_tsconfig_for_tests",
        outs = ["tsconfig_for_tests.json"],
        srcs = [
            "tsconfig_sources.json",
        ],
        cmd = "sed -E -e 's,\"../../../,\",g' $< > $@",
    )

def js_library(package_name = None, srcs = [], **kwargs):
    if package_name != None and not ("package.json" in srcs):
        native.genrule(
            name = "package_json",
            outs = ["package.json"],
            cmd = 'echo \'{"name": "%s","private":true,"version":"0.0.0","types":"index.d.ts"}\' > $@' % package_name,
        )
        new_srcs = ["package.json"]
        new_srcs.extend(srcs)
        srcs = new_srcs
    _js_library(package_name = package_name, srcs = srcs, **kwargs)
