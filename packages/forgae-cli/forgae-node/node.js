/*
 * ISC License (ISC)
 * Copyright (c) 2018 aeternity developers
 *
 *  Permission to use, copy, modify, and/or distribute this software for any
 *  purpose with or without fee is hereby granted, provided that the above
 *  copyright notice and this permission notice appear in all copies.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 *  REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 *  AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 *  INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 *  LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 *  OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 *  PERFORMANCE OF THIS SOFTWARE.
 */
require = require('esm')(module /*, options */) // use to handle es6 import/export

const {
    printError,
    print
} = require('forgae-utils');
const utils = require('forgae-utils');
const {
    spawn
} = require('promisify-child-process');

const fs = require('fs');
const path = require('path');
const dockerCLI = require('docker-cli-js');
const docker = new dockerCLI.Docker();
const nodeConfig = require('forgae-config')
const config = nodeConfig.config;
const defaultWallets = nodeConfig.defaultWallets;
const localCompilerConfig = nodeConfig.compilerConfiguration;
const nodeConfiguration = nodeConfig.nodeConfiguration;

let balanceOptions = {
    format: false
}
let network = utils.config.localhostParams
network.compilerUrl = utils.config.compilerUrl

const MAX_SECONDS_TO_RUN_NODE = 60;

async function waitForContainer (dockerImage) {
    let running = false

    await docker.command('ps', function (err, data) {
        if (err) {
            throw new Error(err);
        }

        data.containerList.forEach(function (container) {
            if (container.image.startsWith(dockerImage) && container.status.indexOf("healthy") != -1) {
                running = true;
            }
        })
    });
    return running;
}

async function fundWallets () {
    await waitToMineCoins()

    let walletIndex = 0;

    let client = await utils.getClient(network);
    await printBeneficiaryKey(client);
    for (let wallet in defaultWallets) {
        await fundWallet(client, defaultWallets[wallet].publicKey)
        await printWallet(client, defaultWallets[wallet], `#${ walletIndex++ }`)
    }
}

async function printBeneficiaryKey (client) {
    await printWallet(client, config.keyPair, "Miner")
}

async function printWallet (client, keyPair, label) {
    let keyPairBalance = await client.balance(keyPair.publicKey, balanceOptions)

    print(`${ label } ------------------------------------------------------------`)
    print(`public key: ${ keyPair.publicKey }`)
    print(`private key: ${ keyPair.secretKey }`)
    print(`Wallet's balance is ${ keyPairBalance }`);
}

async function waitToMineCoins () {
    let client = await utils.getClient(network);
    let heightOptions = {
        interval: 8000,
        attempts: 300
    }
    await client.awaitHeight(10, heightOptions)
}

async function fundWallet (client, recipient) {

    client.setKeypair(config.keyPair)
    await client.spend(config.amountToFund, recipient)

}

function hasNodeConfigFiles () {
    const neededNodeConfigFile = nodeConfiguration.configFileName;
    const neededCompilerConfigFile = localCompilerConfig.configFileName;
    const nodeConfigFilePath = path.resolve(process.cwd(), neededNodeConfigFile);
    const compilerConfigFilePath = path.resolve(process.cwd(), neededCompilerConfigFile);

    let doesNodeConfigFileExists = fs.existsSync(nodeConfigFilePath);
    let doesCompilerConfigFileExists = fs.existsSync(compilerConfigFilePath);

    if (!doesNodeConfigFileExists || !doesCompilerConfigFileExists) {
        console.log(`Missing ${ neededNodeConfigFile } or ${ neededCompilerConfigFile } file!`);
        return false;
    }

    let nodeFileContent = fs.readFileSync(nodeConfigFilePath, 'utf-8');
    let compilerFileContent = fs.readFileSync(compilerConfigFilePath, 'utf-8');

    if (nodeFileContent.indexOf(nodeConfiguration.textToSearch) < 0 || compilerFileContent.indexOf(localCompilerConfig.textToSearch) < 0) {
        console.log(`Invalid ${ neededNodeConfigFile } or ${ neededCompilerConfigFile } file!`);
        return false;
    }

    return true;
}

async function run (option) {

    try {
        let running = await waitForContainer(nodeConfiguration.dockerImage);

        if (option.stop) {
            if (!running) {
                print('===== Node is not running! =====');
                return
            }

            print('===== Stopping node and compiler  =====');

            await spawn('docker-compose', ['-f', 'docker-compose.yml', '-f', 'docker-compose.compiler.yml', 'down', '-v', '--remove-orphans']);
            print('===== Node was successfully stopped! =====');
            print('===== Compiler was successfully stopped! =====');

            return;

        }

        if (!hasNodeConfigFiles()) {
            console.log('Process will be terminated!');
            return;
        }

        if (running) {
            print('\r\n===== Node already started and healthy! =====');
            return;
        }

        print('===== Starting node =====');
        let startingNodeSpawn = spawn('docker-compose', ['-f', 'docker-compose.yml', 'up', '-d']);

        startingNodeSpawn.stdout.on('data', (data) => {
            print(data.toString());
        });

        let errorMessage = '';
        startingNodeSpawn.stderr.on('data', (data) => {
            errorMessage += data.toString();
            print(data.toString())
        });

        let counter = 0;
        while (!(await waitForContainer(nodeConfiguration.dockerImage))) {
            if (errorMessage.indexOf('port is already allocated') >= 0 || errorMessage.indexOf(`address already in use`) >= 0) {
                await spawn('docker-compose', ['-f', 'docker-compose.yml', 'down', '-v', '--remove-orphans'], {});
                throw new Error(`Cannot start AE node, port is already allocated!`)
            }

            process.stdout.write(".");
            utils.sleep(1000);

            // prevent infinity loop
            counter++;
            if (counter >= MAX_SECONDS_TO_RUN_NODE) {
                throw new Error("Cannot start AE Node!")
            }
        }

        print('\n\r===== Node was successfully started! =====');

        if (!option.only) {

            try {
                await startLocalCompiler();

                print(`===== Local Compiler was successfully started! =====`);

            } catch (error) {

                await spawn('docker-compose', ['-f', 'docker-compose.yml', 'down', '-v', '--remove-orphans'], {});
                print('===== Node was successfully stopped! =====');

                const errorMessage = readErrorSpawnOutput(error);
                if (errorMessage.indexOf('port is already allocated') >= 0) {
                    const errorMessage = `Cannot start local compiler, port is already allocated!`;
                    console.log(errorMessage);
                    throw new Error(errorMessage);
                }

                throw new Error(error);
            }
        }

        print('===== Funding default wallets! =====');

        await fundWallets();

        print('\r\n===== Default wallets was successfully funded! =====');
    } catch (e) {
        printError(e.message || e);
    }
}

function startLocalCompiler () {
    return spawn('docker-compose', ['-f', 'docker-compose.compiler.yml', 'up', '-d']);
}

function readErrorSpawnOutput (spawnError) {
    const buffMessage = Buffer.from(spawnError.stderr);
    return buffMessage.toString('utf8');
}

module.exports = {
    run
}