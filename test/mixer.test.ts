const { waffle, ethers } = require("hardhat");
import { ContractFactory, BigNumberish } from "ethers";
import { assert, expect } from "chai";
const BN = require("bn.js");
const fs = require("fs");
const path = require("path");
const F1Field = require("ffjavascript").F1Field;
const snarkjs = require("snarkjs");
import { utils } from "ffjavascript";
const { stringifyBigInts, unstringifyBigInts } = utils;
import * as MIMCMerkle from "../lib/MiMCMerkle";
import test = require("../src/test.js");
import util = require("../src/utils.js");

const {
    randomBytes
} = require('crypto');

const cls = require("circomlibjs");
const SEED = "mimc";
var Amount = ethers.utils.parseEther('0.02');
console.log(Amount.toString())

interface Proof {
    a: [BigNumberish, BigNumberish];
    b: [[BigNumberish, BigNumberish], [BigNumberish, BigNumberish]];
    c: [BigNumberish, BigNumberish];
}

function Bits2Num(n, in1) {
    var lc1 = 0;

    var e2 = 1;
    for (var i = 0; i < n; i++) {
        lc1 += Number(in1[i]) * e2;
        e2 = e2 + e2;
    }
    return lc1
}

function parseProof(proof: any): Proof {
    return {
        a: [proof.pi_a[0], proof.pi_a[1]],
        b: [
            [proof.pi_b[0][1], proof.pi_b[0][0]],
            [proof.pi_b[1][1], proof.pi_b[1][0]],
        ],
        c: [proof.pi_c[0], proof.pi_c[1]],
    };
}


// deposit
// 0,1,2,3
async function deposit(mixerInstance, signer, cmt) {
    var tx = await mixerInstance.deposit(cmt, {
        from: signer,
        value: Amount
    });
    await tx.wait()
    console.log("Deposit done")
}

async function getMimc(mixerInstance, input, sk) {
    let abi = ["event TestMimc(uint256)"]
    var iface = new ethers.utils.Interface(abi)
    let tx = await mixerInstance.getMimc(input, sk)
    let receipt = await tx.wait()
    let logs = iface.parseLog(receipt.events[0]);
    let result = logs.args[0]
}

// getMerkleProof
async function getMerkleProof(mixerInstance, leaf_index) {
    let res = []
    let addressBits = []
    let tx = await mixerInstance.getMerkleProof(leaf_index);
    let receipt = await tx.wait()

    let abi = ["event MerkleProof(uint256[8] , uint256[8] )"]
    var iface = new ethers.utils.Interface(abi);
    let logs = iface.parseLog(receipt.events[0]);
    let proof = logs.args[0]
    let proof2 = logs.args[1]

    for (let i = 0; i < proof.length; i++) {
        let t = proof[i];
        res.push(t.toString())
    }

    for (let i = 0; i < proof2.length; i++) {
        let t = proof2[i];
        addressBits.push(t.toString())
    }
    return [res, addressBits];
}

async function getRoot(mixerInstance) {
    let root = await mixerInstance.getRoot();
    console.log("root:", root.toString())
    return root.toString()
}

/*
async function getRootEx(mixerInstance, leaf, cmtIdx) {
  let tx =  await mixerInstance.getRootEx(leaf, cmtIdx);
  let receipt = await tx.wait()

  let abi = [ "event RootEx(uint256)" ]
  var iface = new ethers.utils.Interface(abi);
  let logs = iface.parseLog(receipt.events[0]); 
  let root = logs.args[0]

  console.log("root:", root.toString())
  return root.toString()
}
*/

const getUniqueLeaf = (mimc, leaf, depth) => {
    if (leaf == 0) {
        for (let i = 0; i < depth; i++) {
            leaf = mimc.hash(leaf, leaf);
        }
    }
    return leaf;
}

async function verify(contract, mimcJS, cmtIdx, secret) {
    const nullifierHash = mimcJS.hash(cmtIdx, secret)
    let cmt = mimcJS.hash(mimcJS.F.toString(nullifierHash), secret)
    let leaf = mimcJS.hash(cmt, Amount.toString());

    let [merklePath, path2RootPos2] = await getMerkleProof(contract, cmtIdx)
    console.log("Path", merklePath, path2RootPos2)
    /* TODO 
       let root = MIMCMerkle.rootFromLeafAndPath(leaf, cmtIdx, merklePath);
       for (let a of root) {
       console.log("Circuit root", mimcJS.F.toString(a))
       }
       let rrr = mimcJS.F.toString(root[root.length - 1])
       console.log("Roots", rrr, await getRoot(contract));
     */
    let root = leaf;
    for (var i = 0; i < 8; i++) {
        if (path2RootPos2[i] == 1) {
            root = mimcJS.hash(root, merklePath[i])
        } else {
            root = mimcJS.hash(merklePath[i], root)
        }
        console.log("Circuit", mimcJS.F.toString(root), merklePath[i])
    }
    //console.log("shit", mimcJS.F.toString(root), await getRootEx(contract, mimcJS.F.toString(leaf), cmtIdx));
    expect(mimcJS.F.toString(root)).to.eq(await getRoot(contract));
    console.log("YES!!!!!!!!!", mimcJS.F.toString(root), root, await getRoot(contract), cmtIdx);

    let input = {
        "root": mimcJS.F.toString(root),
        "amount": Amount.toString(),
        "nullifierHash": mimcJS.F.toString(nullifierHash),
        "secret": secret,
        "paths2_root": merklePath,
        "paths2_root_pos": path2RootPos2
    }

    let wasm = path.join(__dirname, "../circuit/main_js", "main.wasm");
    let zkey = path.join(__dirname, "../circuit/main_js", "circuit_final.zkey");
    const wc = require("../circuit/main_js/witness_calculator");
    const buffer = fs.readFileSync(wasm);
    const witnessCalculator = await wc(buffer);

    const witnessBuffer = await witnessCalculator.calculateWTNSBin(
        input,
        0
    );
    const { proof, publicSignals } = await snarkjs.groth16.prove(zkey, witnessBuffer);
    //const res = await snarkjs.groth16.exportSolidityCallData(proof, "");
    //let result = res.substring(0, res.length - 3);
    const { a, b, c } = parseProof(proof);
    console.log(await getRoot(contract));
    const inputTest = [
        //await getRoot(contract),
        mimcJS.F.toString(root),
        mimcJS.F.toString(nullifierHash),
        Amount.toString(),
    ]

    return [a, b, c, inputTest]
}

const runTest = async (circuit, mimcJS, path2RootPos, path2RootPos2) => {
    // secret
    const secret = "0";
    const LEAF_NUM = 8;
    //console.log(path2_root_pos.join(""))
    // 255 = 11111111b
    //const cmt_index = parseInt(path2_root_pos.reverse().join(""), 2)
    const cmt_index = Bits2Num(LEAF_NUM, path2RootPos2)
    //console.log("cmt index", cmt_index)
    const nullifierHash = mimcJS.hash(cmt_index, secret)
    //console.log("nullifierHash", nullifierHash)
  
    let cmt = mimcJS.hash(nullifierHash, secret)
  
    // generates salt to encrypt each leaf
    let merklePath = [
      '0',
      '11730251359286723731141466095709901450170369094578288842486979042586033922425',
      '9246143820134657901174176070515121907817622693387763521229610032056676659170',
      '3919701857960328675810908960351443394156342162925591865624975500788003961839',
      '11868459870544964516983456008242250460119356993157504951373700810334626455267',
      '17452340833314273101389791943519612073692685328163719737408744891984034913325',
      '5253775198292439148470029927208469781432760606734473405438165226265735347735',
      '9586203148669237657308746417333646936338855598595657703565568663564319347700'
    ]
    const amount = "100";
    // get merkle root
    let root = mimcJS.hash(cmt, amount);
  
    //let root = MIMCMerkle.rootFromLeafAndPath(leaf, cmt_index, merklePath);
  
    for (var i = 0; i < 8; i ++) {
      if (path2RootPos[i] == 1) {
        root = mimcJS.hash(root, merklePath[i])
      } else {
        root = mimcJS.hash(merklePath[i], root)
      }
    }
    
    const circuitInputs = {
      "root": mimcJS.F.toString(root),
      "amount": amount, // unit: wei
      "nullifierHash": mimcJS.F.toString(nullifierHash),
      "secret": secret,
      "paths2_root": merklePath,
      "paths2_root_pos": path2RootPos
    }
  
    await util.executeCircuit(circuit, circuitInputs)
  }

const runForwardTest = async (signer, contract, mimcJS, path2RootPos) => {
    // secret
    const secret = "011"
    const cmtIdx = Bits2Num(8, path2RootPos)
    console.log("cmtIdx", cmtIdx);
    const nullifierHash = mimcJS.hash(cmtIdx, secret)
    let cmt = mimcJS.hash(mimcJS.F.toString(nullifierHash), secret)
    let leaf = mimcJS.hash(cmt, Amount.toString());

    console.log("Deposit")
    console.log("root before deposit", await getRoot(contract))
    await deposit(contract, signer, mimcJS.F.toString(leaf))
    console.log("root after deposit", await getRoot(contract))

    let [a, b, c, inputTest] = await verify(contract, mimcJS, cmtIdx, secret)
    // structure new commitment 
    let newCmtIdx = cmtIdx + 1;
    const newNullifierHash = mimcJS.hash(newCmtIdx, secret)
    let newCmt = mimcJS.hash(mimcJS.F.toString(newNullifierHash), secret)
    let newLeaf = mimcJS.hash(newCmt, Amount.toString());
    let commitment = mimcJS.F.toString(newLeaf)

    console.log("Forward", inputTest)
    await (await contract.forward(
        a, b, c,
        inputTest,
        commitment
    )).wait()

    // withdraw verify
    let [a2, b2, c2, inputTest2] = await verify(contract, mimcJS, newCmtIdx, secret)
    console.log("Withdraw", inputTest)
    await (await contract.withdraw(
        a2, b2, c2,
        inputTest2
    )).wait()
}

describe("Mixer test suite", () => {
    let contract
    let mimcJS
    let mimcContract
    let signer
    let circuit
    before(async () => {
        circuit = await test.genMain(path.join(__dirname, "..", "circuit", "mixer.circom"), "Withdraw", "root, nullifierHash, amount", [8]);
        await circuit.loadSymbols();

        const [signer] = await ethers.getSigners();
        console.log("signer", signer.address);
        mimcJS = await cls.buildMimc7();
        let abi = cls.mimc7Contract.abi
        let createCode = cls.mimc7Contract.createCode
        let f = new ContractFactory(
            abi, createCode(SEED, 91), signer
        )
        mimcContract = await f.deploy()
        await mimcContract.deployed()

        console.log("mimc", mimcContract.address)
        let F = await ethers.getContractFactory("Mixer");
        contract = await F.deploy(mimcContract.address);
        await contract.deployed()

        await MIMCMerkle.init();
    })

    it("Test MIMC", async () => {
        const res = await mimcContract["MiMCpe7"](1, 2);
        const res2 = mimcJS.hash(1, 2);
        assert.equal(res.toString(), mimcJS.F.toString(res2));

        let r = "17476463353520328933908815096303937517517835673952302892565831818490112348179";
        console.log(mimcJS.F.toString(mimcJS.hash(r, r)))
        console.log(mimcJS.F.toString(await mimcContract["MiMCpe7"](r, r)))

        await getMimc(contract, r, r)
    })

    it("Test Mixer Withdraw", async () => {
        let path2RootPos = [0, 0, 0, 0, 0, 0, 0, 0]
        let path2RootPos2 = [1, 1, 1, 1, 1, 1, 1, 1]
        await runTest(circuit, mimcJS, path2RootPos, path2RootPos2)
    
        path2RootPos = [1, 0, 0, 0, 0, 0, 0, 0]
        path2RootPos2 = [0, 1, 1, 1, 1, 1, 1, 1]
        await runTest(circuit, mimcJS, path2RootPos, path2RootPos2)
    
        path2RootPos = [0, 1, 0, 0, 0, 0, 0, 0]
        path2RootPos2 = [1, 0, 1, 1, 1, 1, 1, 1]
        await runTest(circuit, mimcJS, path2RootPos, path2RootPos2)
      });

    it("Test Mixer Forward", async () => {
        // secret
        let path2RootPos = [0, 0, 0, 0, 0, 0, 0, 0]
        await runForwardTest(signer, contract, mimcJS, path2RootPos)
    })
})
