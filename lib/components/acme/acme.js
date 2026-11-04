import crypto from "node:crypto";
import fs from "node:fs";
import AcmeApi from "#core/api/acme";
import fetch from "#core/fetch";
import Interval from "#core/interval";
import sql from "#core/sql";
import { TmpFile } from "#core/tmp";
import { sleep } from "#core/utils";

const HTTP_LOCATION = "/.well-known/acme-challenge/";

const SQL = {
    "getAcmeAccount": sql`SELECT url, key FROM acme_account WHERE email = ? AND test = ?`,

    "upsertAccount": sql`
INSERT INTO acme_account
    ( email, test, url, key )
VALUES
    ( ?, ?, ?, ? )
ON CONFLICT ( email, test ) DO UPDATE SET
    url = EXCLUDED.url,
    key = EXCLUDED.key
`,

    "getCertificate": sql`SELECT certificate, key FROM acme_certificate WHERE domains = ? AND test = ? AND expires > CURRENT_TIMESTAMP`,

    "upsertCertificate": sql`
INSERT INTO acme_certificate
    ( domains, test, expires, certificate, key )
VALUES
    ( ?, ?, ?, ?, ? )
ON CONFLICT ( domains, test ) DO UPDATE SET
    expires = EXCLUDED.expires,
    certificate = EXCLUDED.certificate,
    key = EXCLUDED.key
`,

    "getChallenge": sql`SELECT content FROM acme_challenge WHERE id = ? AND expires > CURRENT_TIMESTAMP`.prepare(),

    "insertChallenge": sql`INSERT INTO acme_challenge ( id, content, expires ) VALUES ( ?, ?, ? )`,

    "deleteChallenge": sql`DELETE FROM acme_challenge WHERE id = ?`,
};

export default class AcmeComponent {
    #app;
    #config;
    #acme;
    #cloudFlareApi;
    #certificatesRenewInterval;

    constructor ( app, config ) {
        this.#app = app;
        this.#config = config;

        this.#certificatesRenewInterval = new Interval( this.#config.certificatesRenewInterval );
    }

    // properties
    get app () {
        return this.#app;
    }

    get dbh () {
        return this.app.dbh;
    }

    get httpLocation () {
        return HTTP_LOCATION;
    }

    get httpEnabled () {
        return this.#config.httpEnabled;
    }

    get dnsEnabled () {
        return this.#config.dnsEnabled;
    }

    // public
    async init () {

        // init db
        let res = await this.app.dbh.schema.migrate( new URL( "db", import.meta.url ) );
        if ( !res.ok ) return res;

        // configure http servers
        if ( this.httpEnabled ) {
            if ( this.app.publicHttpServer ) {
                this.app.publicHttpServer.get( HTTP_LOCATION + "*", this.#downloadAcmeChallenge.bind( this ) );

                this.app.publicHttpServer.head( HTTP_LOCATION + "test", this.#testAcmeChallenge.bind( this ) );
            }

            if ( this.app.privateHttpServer ) {
                this.app.privateHttpServer.get( HTTP_LOCATION + "*", this.#downloadAcmeChallenge.bind( this ) );

                this.app.privateHttpServer.head( HTTP_LOCATION + "test", this.#testAcmeChallenge.bind( this ) );
            }
        }

        // create Cloudflare API
        if ( this.#config.dnsEnabled && this.app.services?.has( this.#config.cloudFlareServiceName ) ) {
            this.#cloudFlareApi = this.app.services?.get( this.#config.cloudFlareServiceName );
        }

        const mutex = this.#getMutex( "init" ),
            locked = await mutex.tryLock();

        if ( !locked ) return mutex.wait();

        ACCOUNT: {

            // get accounnt key from storage
            res = await this.#getAcmeAccount();
            if ( !res.ok ) return res;

            if ( res.data ) {
                var acmeAccount = res.data;
            }

            this.#acme = new AcmeApi( {
                "email": this.#config.email,
                "test": this.#config.test,
                "accountKey": acmeAccount?.accountKey,
                "accountUrl": acmeAccount?.accountUrl,
            } );

            // create acme account
            res = await this.#acme.createAccount();
            if ( !res.ok ) break ACCOUNT;

            // store account key
            if ( !acmeAccount ) {
                res = await this.#storeAcmeAccount( this.#acme.accountUrl, this.#acme.accountKey );

                if ( !res.ok ) break ACCOUNT;
            }

            res = result( 200 );
        }

        await mutex.unlock( res );

        return res;
    }

    async getCertificate ( domains, { pem } = {} ) {
        if ( !Array.isArray( domains ) ) domains = [ domains ];

        domains = domains.sort();

        const id = domains.join( "," );

        const mutex = this.#getMutex( "get-certificate/" + id );

        await mutex.lock();

        var res;

        CERTIFICATE: {

            // get stored certificate
            res = await this.#getStoredCertificate( id, {
                "checkRenewInterval": true,
                pem,
            } );

            // stored certificate is valid
            if ( res.ok ) break CERTIFICATE;

            // get certificate
            res = await this.#acme.getCertificate( {
                domains,
                "checkDomain": this.#checkDomain.bind( this ),
                "createChallenge": this.#createChallenge.bind( this ),
                "deleteChallenge": this.#deleteChallenge.bind( this ),
            } );

            if ( res.ok ) {
                console.info( `[acme] updated certificates for domains: ${ domains }` );
            }
            else {
                break CERTIFICATE;
            }

            // upload certificate
            res = await this.#uploadCertificate( {
                id,
                "certificate": res.data.certificate,
                "privateKey": res.data.privateKey,
                "expires": res.data.expires,
            } );
            if ( !res.ok ) break CERTIFICATE;

            // get stored certificate
            res = await this.#getStoredCertificate( id, {
                pem,
            } );
        }

        await mutex.unlock();

        return res;
    }

    canGetCertificate ( serverName ) {
        return AcmeApi.canGetCertificate( serverName );
    }

    // private
    async #checkDomain ( { name, isWildcard, domain, dnsTxtRecordName, resolved } ) {

        // check http
        if ( resolved && this.httpEnabled ) {
            const url = "http://" + domain + HTTP_LOCATION + "test",
                hostHash = this.#getHostHash( domain );

            let attempts = 3;

            TEST: while ( attempts ) {
                const res = await fetch( url, {
                    "method": "HEAD",
                } );

                if ( res.ok ) {
                    if ( res.headers.get( "x-acme-test" ) === hostHash ) {
                        return true;
                    }
                    else {
                        break TEST;
                    }
                }

                await sleep( 3000 );

                attempts--;
            }
        }

        // check dns
        if ( this.#cloudFlareApi ) {

            // get zone
            const res = await this.#getDomainZone( domain );

            // domains zone found
            if ( res.ok ) return true;
        }

        return false;
    }

    async #createChallenge ( { type, domain, dnsTxtRecordName, httpLocation, token, content } ) {
        var res;

        // http
        if ( type === "http-01" ) {
            if ( !this.httpEnabled ) return result( 500 );

            const res = await this.dbh.do( SQL.insertChallenge, [

                //
                token,
                content,
                new Interval( this.#config.challengeMaxAge ).addDate(),
            ] );

            return res;
        }

        // dns
        else if ( type === "dns-01" ) {
            if ( !this.#cloudFlareApi ) return result( 500 );

            // get zone
            res = await this.#getDomainZone( domain );
            if ( !res.ok ) return res;

            const zone = res.data;

            // delete record, if exists
            await this.#deleteDnsRecord( dnsTxtRecordName, zone );

            // create record
            res = await this.#cloudFlareApi.createDnsRecord( zone.id, {
                "type": "TXT",
                "name": dnsTxtRecordName,
                content,
                "ttl": 60,
            } );
            if ( !res.ok ) return res;

            return result( 200, {
                "dnsTtl": res.data.ttl,
            } );
        }

        // not supported
        else {
            return result( 500 );
        }
    }

    async #deleteChallenge ( { type, domain, dnsTxtRecordName, token, httpLocation } ) {

        // http
        if ( type === "http-01" ) {
            await this.dbh.do( SQL.deleteChallenge, [ token ] );
        }

        // dns
        else if ( type === "dns-01" ) {
            if ( !this.#cloudFlareApi ) return;

            var res;

            // get zone
            res = await this.#getDomainZone( domain );
            if ( !res.ok ) return;

            const zone = res.data;

            await this.#deleteDnsRecord( dnsTxtRecordName, zone );
        }

        // not supported
        else {
            return;
        }
    }

    async #getStoredCertificate ( id, { checkRenewInterval, pem } = {} ) {
        var certificate, privateKey;

        const res = await this.dbh.selectRow( SQL.getCertificate, [

            //
            id,
            this.#config.test,
        ] );

        if ( !res.ok ) return res;

        if ( !res.data ) return result( 404 );

        certificate = await this.app.crypto.decrypt( res.data.certificate );

        privateKey = await this.app.crypto.decrypt( res.data.key );

        const x509Certificate = new crypto.X509Certificate( certificate ),
            expires = Temporal.Instant.from( x509Certificate.validTo );

        if ( expires.epochMilliseconds <= Date.now() ) result( 404 );

        if ( checkRenewInterval ) {

            // renew is required
            if ( this.#certificatesRenewInterval.addDate() >= expires ) return result( 404 );
        }

        if ( pem ) {
            return result( 200, {
                "certificate": certificate.toString( "latin1" ),
                "privateKey": privateKey.toString( "latin1" ),
                "fingerprint": x509Certificate.fingerprint512,
                expires,
            } );
        }
        else {
            const certtificateTmpFile = new TmpFile(),
                privateKeyTmpFile = new TmpFile();

            fs.writeFileSync( certtificateTmpFile.path, certificate );

            fs.writeFileSync( privateKeyTmpFile.path, privateKey );

            return result( 200, {
                "certificatePath": certtificateTmpFile,
                "privateKeyPath": privateKeyTmpFile,
                "fingerprint": x509Certificate.fingerprint512,
                expires,
            } );
        }
    }

    async #uploadCertificate ( { id, certificate, privateKey, expires } ) {
        certificate = await this.app.crypto.encrypt( certificate );

        privateKey = await this.app.crypto.encrypt( privateKey );

        return this.dbh.do( SQL.upsertCertificate, [

            //
            id,
            this.#config.test,
            expires,
            certificate,
            privateKey,
        ] );
    }

    #getMutex ( id ) {
        id = "/acme/" + id;

        return this.app.cluster.mutexes.get( id );
    }

    async #getDomainZone ( domain ) {
        const res = await this.#cloudFlareApi.getZones();
        if ( !res.ok ) return res;

        for ( const zone of res.data ) {
            if ( domain === zone.name || domain.endsWith( `.${ zone.name }` ) ) {
                return result( 200, zone );
            }
        }

        return result( [ 404, "Domain zone not found" ] );
    }

    async #deleteDnsRecord ( dnsTxtRecordName, zone ) {
        var res;

        // get records
        res = await this.#cloudFlareApi.getDnsRecords( zone.id );
        if ( !res.ok ) return;

        // delete record
        for ( const record of res.data ) {
            if ( record.type !== "TXT" ) continue;

            if ( record.name !== dnsTxtRecordName ) continue;

            await this.#cloudFlareApi.deleteDnsRecord( zone.id, record.id );

            return;
        }
    }

    #getHostHash ( host ) {
        return crypto.createHmac( "SHA256", this.#acme.accountKey ).update( host ).digest( "base64url" );
    }

    async #downloadAcmeChallenge ( req ) {
        const id = req.path.slice( HTTP_LOCATION.length );

        var challenge;

        const res = await this.dbh.selectRow( SQL.getChallenge, [

            //
            id,
        ] );

        if ( !res.ok ) return req.end( res );

        challenge = res.data?.content;

        if ( !challenge ) return req.end( 404 );

        return req.end( {
            "status": 200,
            "headers": {
                "cache-control": "no-cache",
            },
            "body": challenge,
        } );
    }

    async #testAcmeChallenge ( req ) {
        const host = req.headers.get( "host" );

        if ( !host ) {
            return req.end( 400 );
        }
        else {
            return req.end( {
                "status": 200,
                "headers": {
                    "x-acme-test": this.#getHostHash( host ),
                },
            } );
        }
    }

    async #getAcmeAccount () {
        var account;

        const res = await this.dbh.selectRow( SQL.getAcmeAccount, [

            //
            this.#config.email,
            this.#config.test,
        ] );

        if ( !res.ok ) return res;

        if ( res.data ) {
            account = {
                "accountUrl": res.data.url,
                "accountKey": res.data.key,
            };
        }

        if ( account?.accountKey ) {
            account.accountKey = await this.app.crypto.decrypt( account.accountKey );
        }

        return result( 200, account );
    }

    async #storeAcmeAccount ( accountUrl, accountKey ) {
        accountKey = await this.app.crypto.encrypt( crypto.createPrivateKey( accountKey ).export( {
            "type": "pkcs8",
            "format": "der",
        } ) );

        const res = await this.dbh.do( SQL.upsertAccount, [

            //
            this.#config.email,
            this.#config.test,
            accountUrl,
            accountKey,
        ] );

        if ( !res.ok ) return res;

        return result( 200 );
    }
}
