module credential_framework::credentials {
    use sui::object::{Self, UID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::vec_set::{Self, VecSet};
    use sui::event;
    use std::string::{Self, String};

    /// -------- Errors --------
    const E_NOT_ISSUER: u64 = 0;
    const E_CONTEXT_ISSUER_MISMATCH: u64 = 1;
    const E_REGISTRY_ISSUER_MISMATCH: u64 = 2;

    /// Issuer admin capability (kept address-owned by the issuer)
    public struct IssuerCap has key {
        id: UID,
        issuer: address,
    }

    /// Shared registry (publicly readable) for revocations
    public struct Registry has key, store {
        id: UID,
        issuer: address,
        name: String,
        revoked: VecSet<address>,
    }

    /// Context: event / course / IP round / etc.
    public struct Context has key, store {
        id: UID,
        issuer: address,
        title: String,
        description: String,
    }

    /// The actual credential “NFT” (address-owned object transferred to recipient)
    public struct Credential has key, store {
        id: UID,
        issuer: address,
        recipient: address,
        context: address,     // Context object id as address
        title: String,
        issued_at_ms: u64,
        doc_ref: String,      // later: Walrus object id / URL / hash reference
    }

    /// Events (helpful for indexing later)
    public struct IssuerCreated has copy, drop {
        issuer: address,
        cap_id: address,
        registry_id: address,
    }

    public struct ContextCreated has copy, drop {
        issuer: address,
        context_id: address,
    }

    public struct CredentialIssued has copy, drop {
        issuer: address,
        recipient: address,
        context: address,
        credential_id: address,
    }

    public struct CredentialRevoked has copy, drop {
        issuer: address,
        credential_id: address,
    }

    fun assert_issuer(cap: &IssuerCap, ctx: &TxContext) {
        assert!(cap.issuer == tx_context::sender(ctx), E_NOT_ISSUER);
    }

    /// 1) create issuer:
    /// - gives issuer an IssuerCap
    /// - creates a shared Registry (with organization name) for revocation checks
    public entry fun create_issuer(name: String, ctx: &mut TxContext) {
        let issuer = tx_context::sender(ctx);

        let cap = IssuerCap { id: object::new(ctx), issuer };
        let registry = Registry {
            id: object::new(ctx),
            issuer,
            name,
            revoked: vec_set::empty<address>(),
        };

        let cap_id = object::id_to_address(&object::id(&cap));
        let registry_id = object::id_to_address(&object::id(&registry));

        // IssuerCap is address-owned (only issuer controls it)
        transfer::transfer(cap, issuer);

        // Registry is shared (anyone can read + use it in transactions)
        transfer::public_share_object(registry);

        event::emit(IssuerCreated { issuer, cap_id, registry_id });
    }

    /// 2) create context (event/course/etc.)
    public entry fun create_context(
        cap: &IssuerCap,
        title: String,
        description: String,
        ctx: &mut TxContext
    ) {
        assert_issuer(cap, ctx);

        let issuer = cap.issuer;
        let context = Context { id: object::new(ctx), issuer, title, description };
        let context_id = object::id_to_address(&object::id(&context));

        // Context is address-owned by issuer
        transfer::public_transfer(context, issuer);

        event::emit(ContextCreated { issuer, context_id });
    }

    /// 3) issue credential NFT to recipient
    public entry fun issue_credential(
        cap: &IssuerCap,
        registry: &Registry,
        context: &Context,
        recipient: address,
        title: String,
        doc_ref: String,
        ctx: &mut TxContext
    ) {
        assert_issuer(cap, ctx);
        assert!(registry.issuer == cap.issuer, E_REGISTRY_ISSUER_MISMATCH);
        assert!(context.issuer == cap.issuer, E_CONTEXT_ISSUER_MISMATCH);

        let issuer = cap.issuer;
        let context_id = object::id_to_address(&object::id(context));

        let credential = Credential {
            id: object::new(ctx),
            issuer,
            recipient,
            context: context_id,
            title,
            issued_at_ms: tx_context::epoch_timestamp_ms(ctx),
            doc_ref,
        };

        let credential_id = object::id_to_address(&object::id(&credential));

        // Credential is address-owned by recipient
        transfer::public_transfer(credential, recipient);

        event::emit(CredentialIssued {
            issuer,
            recipient,
            context: context_id,
            credential_id,
        });
    }

    /// 4) revoke: issuer adds credential_id to registry.revoked
    public entry fun revoke(
        cap: &IssuerCap,
        registry: &mut Registry,
        credential_id: address,
        ctx: &mut TxContext
    ) {
        assert_issuer(cap, ctx);
        assert!(registry.issuer == cap.issuer, E_REGISTRY_ISSUER_MISMATCH);

        vec_set::insert(&mut registry.revoked, credential_id);
        event::emit(CredentialRevoked { issuer: cap.issuer, credential_id });
    }

    /// 5) simple on-chain check (useful for CLI dev-inspect)
    /// aborts if revoked
    public entry fun assert_not_revoked(
        registry: &Registry,
        credential_id: address,
        _ctx: &mut TxContext
    ) {
        assert!(!vec_set::contains(&registry.revoked, &credential_id), 999);
    }
}
