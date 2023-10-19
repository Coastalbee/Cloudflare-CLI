import { mkdir } from "fs/promises";
import { exit } from "process";
import { error, logRaw, space, status, updateStatus } from "@cloudflare/cli";
import { dim, brandColor } from "@cloudflare/cli/colors";
import { inputPrompt, spinner } from "@cloudflare/cli/interactive";
import {
	type ArgumentsCamelCase as ArgumentsCamelCaseRaw,
	type CamelCaseKey,
	type Argv,
} from "yargs";
import { version as wranglerVersion } from "../../package.json";
import { readConfig } from "../config";
import { getConfigCache, purgeConfigCaches } from "../config-cache";
import { getCloudflareApiBaseUrl } from "../environment-variables/misc-variables";
import { CI } from "../is-ci";
import isInteractive from "../is-interactive";
import {
	getAPIToken,
	getAccountId,
	requireAuth,
	getAuthFromEnv,
	reinitialiseAuthTokens,
	getScopes,
	logout,
	setLoginScopeKeys,
} from "../user";
import { ApiError, DeploymentMutationError, OpenAPI } from "./client";
import { wrap } from "./helpers/wrap";
import { idToLocationName, loadAccount } from "./locations";
import type { Config } from "../config";
import type { CommonYargsOptions } from "../yargs-types";
import type { EnvironmentVariable, CompleteAccountCustomer } from "./client";
import type { Arg } from "@cloudflare/cli/interactive";

export type CommonCloudchamberConfiguration = { json: boolean };

/**
 * Same as ArgumentsCamelCase from yargs but without $0 and __
 */
export type ArgumentsCamelCase<T = Record<string, unknown>> = {
	[key in keyof T as key | CamelCaseKey<key>]: T[key];
};

export type inferYargs<
	T,
	K = T extends Argv<infer R> ? R : never
> = ArgumentsCamelCase<K>;

export type inferYargsFn<T extends (...args: Argv<T>[]) => unknown> =
	inferYargs<ReturnType<T>>;

/**
 * Wrapper so it's easy to filter out arguments that we don't want, and parses wrangler configuration.
 * It also wraps exceptions and checks if they are from the RestAPI.
 *
 * Usage:
 * ```
 * 	async (args) =>
 *    handleFailure<typeof args>(async (deploymentArgs, generalConfig) => { // now you have inferred everything until now, and input is sanitized
 *      // code ...
 *    });
 *
 * ```
 * @param cb
 * @returns
 */
export function handleFailure<
	T,
	K = T extends ArgumentsCamelCaseRaw<
		CommonYargsOptions & CommonCloudchamberConfiguration & infer R
	>
		? R
		: never
>(
	cb: (
		t: ArgumentsCamelCase<K>,
		config: CommonCloudchamberConfiguration &
			CommonYargsOptions & { wranglerConfig: Config }
	) => Promise<void>
): (
	t: CommonYargsOptions & T & CommonCloudchamberConfiguration
) => Promise<void> {
	return async (t) => {
		try {
			const config = readConfig(
				t.config,
				t as unknown as Parameters<typeof readConfig>[1]
			);
			await fillOpenAPIConfiguration(config, t.json);
			const rawAnyT = { ...t } as Partial<
				ArgumentsCamelCaseRaw<
					K & CommonYargsOptions & CommonCloudchamberConfiguration
				>
			>;
			// strip any data that comes from yarg
			delete rawAnyT["$0"];
			delete rawAnyT["_"];
			delete rawAnyT["env"];
			delete rawAnyT["experimental-json-config"];
			delete rawAnyT["v"];
			delete rawAnyT["experimentalJsonConfig"];
			delete rawAnyT["json"];
			delete rawAnyT["config"];
			await cb(rawAnyT as unknown as ArgumentsCamelCase<K>, {
				json: t.json,
				config: t.config,
				"experimental-json-config": t["experimental-json-config"],
				env: t.env,
				v: t.v,
				wranglerConfig: config,
			});
		} catch (err) {
			if (!t.json) {
				throw err;
			}

			if (err instanceof ApiError) {
				console.error(JSON.stringify(err.body));
				return;
			}

			console.error(JSON.stringify(err));
		}
	};
}

export async function loadAccountSpinner({ json }: { json?: boolean }) {
	await promiseSpinner(loadAccount(), { message: "Loading account", json });
}

/**
 * Gets the API URL depending if the user is using old/admin based authentication.
 *
 */
async function getAPIUrl(config: Config) {
	const api = getCloudflareApiBaseUrl();
	// This one will probably be cache'd already so it won't ask for the accountId again
	const accountId = config.account_id || (await getAccountId());
	return `${api}/accounts/${accountId}/cloudchamber`;
}

export async function promiseSpinner<T>(
	promise: Promise<T>,
	{
		json = false,
		message = "Loading",
	}: { json?: boolean; message?: string } = {
		json: false,
		message: "Loading",
	}
): Promise<T> {
	if (json) return promise;
	const { start, stop } = spinner();
	start(message);
	const t = await promise.catch((err) => {
		stop();
		throw err;
	});
	stop();
	return t;
}

export async function fillOpenAPIConfiguration(config: Config, json: boolean) {
	const headers: Record<string, string> = {};

	// if the config cache folder doesn't exist, it means that there is not a node_modules folder in the tree
	if (Object.keys(getConfigCache("wrangler-account.json")).length === 0) {
		await wrap(mkdir("node_modules", {}));
		purgeConfigCaches();
	}

	const scopes = getScopes();
	const needsCloudchamberToken = !scopes?.find(
		(scope) => scope === "cloudchamber:write"
	);

	setLoginScopeKeys(["cloudchamber:write", "user:read", "account:read"]);

	if (getAuthFromEnv()) {
		// Wrangler will try to retrieve the oauth token and refresh it
		// for its internal fetch call even if we have AuthFromEnv.
		// Let's mock it
		reinitialiseAuthTokens({
			expiration_time: "2300-01-01:00:00:00+00:00",
			oauth_token: "_",
		});
	} else {
		if (needsCloudchamberToken && scopes) {
			logRaw(
				status.warning +
					" We need to re-authenticate with a cloudchamber token..."
			);
			await promiseSpinner(logout(), { json, message: "Revoking token" });
		}

		// Require either login, or environment variables being set to authenticate
		//
		// This will prompt the user for an accountId being chosen if they haven't configured the account id yet
		await requireAuth(config);
	}

	// Get the loaded API token
	const token = getAPIToken();
	if (!token) {
		error("unexpected apiToken not existing in credentials");
		exit(1);
	}

	const val = "apiToken" in token ? token.apiToken : null;
	// Don't try to support this method of authentication
	if (!val) {
		error(
			"we don't allow for authKey/email credentials, use `wrangler login` or CLOUDFLARE_API_TOKEN env variable to authenticate"
		);
		exit(1);
	}

	headers["Authorization"] = `Bearer ${val}`;
	// These are being set by the internal fetch of wrangler, but we are not using it
	// due to our OpenAPI codegenerated client.
	headers["User-Agent"] = `wrangler/${wranglerVersion}`;
	OpenAPI.CREDENTIALS = "omit";
	OpenAPI.BASE = await getAPIUrl(config);
	OpenAPI.HEADERS = headers;
	await loadAccountSpinner({ json });
}

export type CloudchamberConfiguration = CommonYargsOptions &
	CommonCloudchamberConfiguration;

export type ContainerCommandFunction<T> = (
	args: T,
	config: CloudchamberConfiguration
) => Promise<void>;

export function interactWithUser(config: { json?: boolean }): boolean {
	return !config.json && isInteractive() && !CI.isCI();
}

type NonObject = undefined | null | boolean | string | number;

export type DeepComplete<T> = T extends NonObject
	? T extends undefined
		? never
		: T
	: DeepCompleteObject<T>;

declare type DeepCompleteObject<T> = {
	[K in keyof T]-?: DeepComplete<T[K]>;
};

export function checkEverythingIsSet<T>(
	object: T,
	keys: Array<keyof T>
): DeepComplete<T> {
	keys.forEach((key) => {
		if (object[key] === undefined) {
			throw new Error(
				`${key as string} is required but it's not passed as an argument`
			);
		}
	});

	return object as DeepComplete<T>;
}

export function renderDeploymentConfiguration(
	action: "modify" | "create",
	{
		image,
		location,
		vcpu,
		memory,
		environmentVariables,
		env,
	}: {
		image: string;
		location: string;
		vcpu: number;
		memory: string;
		environmentVariables: EnvironmentVariable[] | undefined;
		env?: string;
	}
) {
	let environmentVariablesText = "[]";
	if (environmentVariables !== undefined) {
		if (environmentVariables.length !== 0) {
			environmentVariablesText =
				"\n" +
				environmentVariables
					.map((ev) => "- " + dim(ev.name + ":" + ev.value))
					.join("\n")
					.trim();
		}
	} else if (action === "create") {
		environmentVariablesText = `\nNo environment variables added! You can set some under [${
			env ? "env." + env + "." : ""
		}vars] and via command line`;
	}

	const containerInformation = [
		["Image", image],
		["Location", idToLocationName(location)],
		["VCPU", `${vcpu}`],
		["Memory", memory],
		["Environment variables", environmentVariablesText],
	] as const;

	updateStatus(
		`You're about to ${action} a container with the following configuration\n` +
			containerInformation
				.map(([key, text]) => `${brandColor(key)} ${dim(text)}`)
				.join("\n")
	);
}

export function renderDeploymentMutationError(
	account: CompleteAccountCustomer,
	err: Error
) {
	if (!(err instanceof ApiError)) {
		error(err.message);
		return;
	}

	if (!("error" in err.body)) {
		error(err.message);
		return;
	}

	const errorMessage = err.body.error;
	if (!(errorMessage in DeploymentMutationError)) {
		error(err.message);
		return;
	}

	const details: Record<string, string> = err.body.details ?? {};
	function renderAccountLimits() {
		return `${space(2)}${brandColor("Maximum VCPU per deployment")} ${
			account.limits.vcpu_per_deployment
		}\n${space(2)}${brandColor("Maximum total VCPU in your account")} ${
			account.limits.total_vcpu
		}\n${space(2)}${brandColor("Maximum memory per deployment")} ${
			account.limits.memory_per_deployment
		}\n${space(2)}${brandColor("Maximum total memory in your account")} ${
			account.limits.total_memory
		}`;
	}

	function renderInvalidInputDetails(inputDetails: Record<string, string>) {
		return `${Object.keys(inputDetails)
			.map((key) => `${space(2)}- ${key}: ${inputDetails[key]}`)
			.join("\n")}`;
	}

	const errorEnum = errorMessage as DeploymentMutationError;
	const errorEnumToErrorMessage: Record<DeploymentMutationError, () => string> =
		{
			[DeploymentMutationError.LOCATION_NOT_ALLOWED]: () =>
				"The location you have chosen is not allowed, try with another one",
			[DeploymentMutationError.LOCATION_SURPASSED_BASE_LIMITS]: () =>
				"The location you have chosen doesn't allow that deployment configuration due to its limits",
			[DeploymentMutationError.SURPASSED_BASE_LIMITS]: () =>
				"You deployment surpasses the base limits of your account\n" +
				renderAccountLimits(),
			[DeploymentMutationError.VALIDATE_INPUT]: () =>
				"Your deployment configuration has invalid inputs\n" +
				renderInvalidInputDetails(err.body.details),
			[DeploymentMutationError.SURPASSED_TOTAL_LIMITS]: () =>
				"You have surpassed the limits of your account\n" +
				renderAccountLimits(),
			[DeploymentMutationError.IMAGE_REGISTRY_NOT_CONFIGURED]: () =>
				"You have to configure the domain of the image you're trying to set\n",
		};

	error(details["reason"] ?? errorEnumToErrorMessage[errorEnum]());
}

export function sortEnvironmentVariables(
	environmentVariables: EnvironmentVariable[]
) {
	environmentVariables.sort((a, b) => a.name.localeCompare(b.name));
}

export function collectEnvironmentVariables(
	deploymentEnv: EnvironmentVariable[] | undefined,
	config: Config,
	envArgs: string[] | undefined
): EnvironmentVariable[] | undefined {
	const envMap: Map<string, string> = new Map();

	// environment variables that are already in use are of
	// lowest precedence
	if (deploymentEnv !== undefined) {
		deploymentEnv.forEach((ev) => envMap.set(ev.name, ev.value));
	}

	Object.entries(config.vars).forEach(([name, value]) =>
		envMap.set(name, value?.toString() ?? "")
	);

	// environment variables passed as command-line arguments are of
	// highest precedence
	if (envArgs !== undefined) {
		envArgs.forEach((v) => {
			const [name, ...value] = v.split(":");
			envMap.set(name, value.join(":"));
		});
	}

	if (envMap.size === 0) {
		return undefined;
	}

	const env: EnvironmentVariable[] = Array.from(envMap).map(
		([name, value]) => ({ name: name, value: value })
	);
	sortEnvironmentVariables(env);

	return env;
}

export async function promptForEnvironmentVariables(
	environmentVariables: EnvironmentVariable[] | undefined,
	initiallySelected: string[],
	allowSkipping: boolean
): Promise<EnvironmentVariable[] | undefined> {
	if (environmentVariables === undefined || environmentVariables.length == 0) {
		return undefined;
	}

	let options = [
		{ label: "Use all of them", value: "all" },
		{ label: "Use some", value: "select" },
		{ label: "Do not use any", value: "none" },
	];
	if (allowSkipping) {
		options = [{ label: "Do not modify", value: "skip" }].concat(options);
	}
	const action = await inputPrompt({
		question:
			"You have environment variables defined, what do you want to do for this deployment?",
		label: "",
		defaultValue: false,
		helpText: "",
		type: "select",
		options,
	});

	if (action === "skip") {
		return undefined;
	}
	if (action === "all") {
		return environmentVariables;
	}

	if (action === "select") {
		const selectedNames = await inputPrompt<string[]>({
			question: "Select the environment variables you want to use",
			label: "",
			defaultValue: initiallySelected,
			helpText: "Use the 'space' key to select. Submit with 'enter'",
			type: "multiselect",
			options: environmentVariables.map((ev) => ({
				label: ev.name,
				value: ev.name,
			})),
			validate: (values: Arg) => {
				if (!Array.isArray(values)) return "unknown error";
			},
		});

		const selectedNamesSet = new Set(selectedNames);
		const selectedEnvironmentVariables = [];

		for (const ev of environmentVariables) {
			if (selectedNamesSet.has(ev.name)) selectedEnvironmentVariables.push(ev);
		}

		return selectedEnvironmentVariables;
	}

	return [];
}