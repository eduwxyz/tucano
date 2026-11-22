// Every byte the agents' browser extensions bring in, named here and nowhere else. Nothing is asked for by
// "latest": a file that doesn't hash to its line below is refused, and moving to a new version is a change
// to this table that someone reviews.
//
// To move one: download it from the address on its line, take `shasum -a 256`, and change the version, the
// address and the hash together. A store address carries its version at the end, and the store's update
// endpoint (clients2.google.com/service/update2/crx?response=redirect&x=id%3D<id>%26uc) is what redirects
// to the current one.
import type { AddOn } from '../shared/types'

export interface AddOnPins {
  // Chrome for Testing, one archive per system, from storage.googleapis.com/chrome-for-testing-public.
  browser: { version: string; sha256: Readonly<Record<string, string>> }
  // The .crx of each extension, exactly as the Chrome Web Store serves that version.
  extensions: Readonly<Record<AddOn, { version: string; url: string; sha256: string }>>
  // Consent-O-Matic's rules, which it would otherwise read from its repository's `master` on every run:
  // the commit they are taken from, and the hash of the one file they are merged into (chrome-addons.ts).
  consentRules: { commit: string; sha256: string }
}

export const ADD_ON_PINS: AddOnPins = {
  browser: {
    version: '158.0.8127.36',
    sha256: {
      'linux-arm64': 'f811b64a50cbc73f94fda7b3f3b3bf62be5d9409b3207e6ead9b61e6706afffe',
      linux64: 'dba9cc838e1ce269c33ea68170881127bd15d078fc3ca5891c90802819a4d7c7',
      'mac-arm64': 'b86d3b393def1f87d369b022abff0a51acb015d6fcb79ddfd1c379c9d72fbbe2',
      'mac-x64': '1390e9b1386a1fd8ec2c4940b9ff59cbbda71b896b85182d7efbd73c58213802',
      win32: '427a02beb8887ceca6a1847dc67445580741c8c40bd15af334993d3a59863943',
      win64: '6a8ad290952cc612c7777ffb3eb62f345539a2a1a8d440cfac190c6d36b34d2c'
    }
  },
  extensions: {
    ads: {
      version: '2026.1116.1650',
      url: 'https://clients2.googleusercontent.com/crx/blobs/ARGaeZLeALIRsuijSwhFBl-Z0ltArvPUOJ-CKdMbUL3RI27qxXQehxFLDTs-E5uh-kq2wKXL36kpjPwSzzPf1A9UBtpDmtC3CWFFVL7CTNsJQj4pTUnzlsthgtG2tNiagPuQAMZSmuXNQ96tXtyqK_JDDWtYTsok8YbagA/DDKJIAHEJLHFCAFBDDMGIAHCPHECMPFH_2026_1116_1650_0.crx',
      sha256: '0908f4b6d19a38f2681bd746e4597d7818f083bb3e2e3cc5534b407d896b07fd'
    },
    cookies: {
      version: '1.1.9',
      url: 'https://clients2.googleusercontent.com/crx/blobs/ARGaeZIqLVt77LbJs7FedSN6-rOpkhkPB3fytJQElht57y_SyNdb5e4h5dgyHczTGlvVGYd6LApFWTEHDfCOT7R8EruNyFxlRQJIvjpHEpYBL4IyCrfqTglU0yVaDWjiAEcAxlKa5WmWXa830mPiSjX5LU-sp6TSonwN/EDIBDBJCNIADPCCECJDFDJJPPCPCHDLM_1_1_9_0.crx',
      sha256: '46b6cdc30343dd297c6d34d9179c5e1cc1ee404c8e63b154def158e13010c37d'
    },
    consent: {
      version: '1.1.3',
      url: 'https://clients2.googleusercontent.com/crx/blobs/ARGaeZLptpvj8_xHrjB_hhn54eo_fRSFPRJz_Ji9ElIS8kRMCiRrWZCWi1rAFSEsihaGMsOukilJjZV6BSTYFP33TAZYDv7-mNhMJgeZ2ep018w78S27aQ9eHBdUrkXe0AsAxlKa5S_WRx6NawiA_9qm5tE085cU-o-9/MDJILDAFKNIHDFFPKFMMPNPOIAJFJNJD_1_1_3_0.crx',
      sha256: 'a9d31d91a90131f7d3cab2dc3e337e43f75f4f2b68e7fde812e0cd24a813be98'
    },
    popups: {
      version: '2.1.3',
      url: 'https://clients2.googleusercontent.com/crx/blobs/ARGaeZJB4mw7WqAUka1jUkaObfaBKi73qpa3ntbX4qeDi1zbagAvbR6k0UFqGzRvRE-iVQFviEQ0Kg9uVtsiaM_cgulQRPedHIQeRqArdQqm1wz-045RAMZSmuWY0WbtU45oVHhz2dul1GAo8NvUtA/IFNKDBPMGKDBFKLNBFIDAACKDENLMHGH_2_1_3_0.crx',
      sha256: '3e5f4ac6da69a41f128d013a3dad717f2df0c2082b1a98156fac6c08a37a7403'
    },
    clutter: {
      version: '1.7.5',
      url: 'https://clients2.googleusercontent.com/crx/blobs/ARGaeZIWzwtYWH25rBBM1OLZ557z-BJebvHBwk7lVJ3NyezwMu5RXIDQ0fkSBAICJHfwgYovI8NAZcBryu2s0tdfTQ1JFbJINLNXIR_9S_avD_kDaBcixADGUprl-eO_rs2Ze0N_itKWLNJRz_1TV5c/IBCKHPIJBDMDOBHHHODKCEFFDNGNGLPK_1_7_5_0.crx',
      sha256: 'ce92b9df4977fbc9add0cef3dfaaeb99e8d5b0418bfa164ac53659cbec970caf'
    }
  },
  consentRules: {
    commit: '8ca8500d26434c586039e126ad091e1bfccd205d',
    sha256: 'eee1c6f98dde31fa19a9896bfb202458ce8a67e18a856f96840a0a34dea6b819'
  }
}
